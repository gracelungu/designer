import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DevProcess } from './project.js';
import { findStories } from './project.js';
import { devLaunch, freePort, indexComponents, planProject } from './setup.js';
import type { SetupState, SetupStep, SetupStepId } from '../shared/protocol.js';

export interface AutoSetupHost {
  app: DevProcess;
  /** Shares progress with the window. */
  publish(state: SetupState): void;
  /** The app's dev server is up (puts it on the canvas). */
  onAppUrl(url: string): void;
  /** Finds or starts the project's Storybook, so components render the moment they are placed. */
  warmStorybook?(): Promise<string>;
  /** Installs dependencies. Defaults to running the command in a shell. */
  install?(command: string, cwd: string): Promise<void>;
}

const LABELS: Record<SetupStepId, string> = {
  detect: 'Work out how the project runs',
  index: 'Find its components',
  install: 'Install dependencies',
  start: 'Start the dev server',
  storybook: 'Get components ready for the canvas',
};

/** Runs a command, failing with the end of its output when it exits non-zero. */
export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', npm_config_yes: 'true' } });
    let out = '';
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-4000));
    p.stdout?.on('data', keep);
    p.stderr?.on('data', keep);
    const t = setTimeout(() => (p.kill(), fail(new Error(`"${command}" took longer than ${Math.round(timeoutMs / 60000)} minutes.`))), timeoutMs);
    p.on('error', (e) => (clearTimeout(t), fail(e)));
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) done();
      else fail(new Error(`"${command}" failed (exit ${code}).\n${out.split('\n').slice(-12).join('\n')}`));
    });
  });
}

/**
 * The zero-config setup Designer runs when a project is added: work out the framework and package
 * manager, list the components, install if it was never installed, start the dev server, and get
 * Storybook ready. Opening another project cancels a run in progress.
 */
export class AutoSetup {
  state?: SetupState;
  private generation = 0;

  cancel() {
    this.generation++;
    this.state = undefined;
  }

  async run(cwd: string, host: AutoSetupHost): Promise<SetupState> {
    const gen = ++this.generation;
    const state: SetupState = {
      project: cwd,
      status: 'running',
      steps: (Object.keys(LABELS) as SetupStepId[]).map((id) => ({ id, label: LABELS[id], status: 'pending' })),
      components: 0,
    };
    this.state = state;
    const live = () => gen === this.generation;
    const publish = () => live() && host.publish(structuredClone(state));
    const step = (id: SetupStepId, patch: Partial<SetupStep>) => {
      Object.assign(state.steps.find((s) => s.id === id)!, patch);
      publish();
    };
    publish();

    try {
      step('detect', { status: 'running' });
      const plan = await planProject(cwd);
      if (!live()) return state;
      state.plan = plan;
      const where = plan.appDir === '.' ? '' : ` in ${plan.appDir}`;
      step('detect', { status: 'done', detail: `${plan.frameworkName} with ${plan.packageManager}${where}` });

      step('index', { status: 'running' });
      const stories = await findStories(cwd);
      const components = await indexComponents(cwd, stories);
      if (!live()) return state;
      state.components = components.length;
      const withStory = components.filter((c) => c.storyIds.length).length;
      step('index', {
        status: 'done',
        detail: components.length ? `${components.length} component${components.length === 1 ? '' : 's'}${withStory ? `, ${withStory} with stories` : ''}` : 'No components found yet',
      });

      if (plan.needsInstall && plan.installCommand) {
        step('install', { status: 'running', detail: plan.installCommand });
        await (host.install ?? runCommand)(plan.installCommand, join(cwd, plan.installDir));
        if (!live()) return state;
        step('install', { status: 'done', detail: plan.installCommand });
      } else step('install', { status: 'skipped', detail: plan.installCommand ? 'Already installed' : 'Nothing to install' });

      const appDir = join(cwd, plan.appDir);
      if (host.app.url && host.app.cwd === appDir) {
        state.appUrl = host.app.url;
        step('start', { status: 'done', detail: host.app.url });
      } else {
        const launch = devLaunch(plan, await freePort());
        if (!launch) step('start', { status: 'skipped', detail: 'No dev server found. Ask Claude to set one up.' });
        else {
          step('start', { status: 'running', detail: launch.command.startsWith('"') ? 'Serving the folder' : launch.command });
          const url = await host.app.start(appDir, launch.command, launch.env);
          if (!live()) return state;
          state.appUrl = url;
          host.onAppUrl(url);
          step('start', { status: 'done', detail: url });
        }
      }

      if (stories.length && host.warmStorybook) {
        step('storybook', { status: 'running' });
        try {
          state.storybookUrl = await host.warmStorybook();
          if (!live()) return state;
          step('storybook', { status: 'done', detail: `Storybook at ${state.storybookUrl}` });
        } catch (e) {
          if (!live()) return state;
          // Not fatal: the page is running; components can still be started later.
          step('storybook', { status: 'failed', detail: (e as Error).message.split('\n')[0] });
        }
      } else step('storybook', { status: 'skipped', detail: stories.length ? undefined : 'No stories yet' });

      state.status = 'done';
    } catch (e) {
      if (!live()) return state;
      const running = state.steps.find((s) => s.status === 'running');
      if (running) running.status = 'failed';
      for (const s of state.steps) if (s.status === 'pending') s.status = 'skipped';
      state.status = 'failed';
      state.error = (e as Error).message;
    }
    publish();
    return state;
  }
}
