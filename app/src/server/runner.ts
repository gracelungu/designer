// Project setup, done by Claude. When a project is opened, Designer hands the local Claude Code one
// generic job: understand this repo, work out how it runs (whatever the stack), get it running, and
// report back. Claude starts servers through Designer's setup tools, so Designer owns the processes and
// knows their URLs. Every step Claude plans and every command it runs streams to the window as tasks.
// What worked is saved to .designer/run.json, so the next open replays it in seconds without Claude.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ClaudeCli, type CliMessage, type CliOptions } from './claudeCli.js';
import type { DevProcess } from './project.js';
import { freePort, planProject } from './setup.js';
import type { ToolServer } from './mcp.js';
import type { ProjectProfile, RecipeCommand, RunRecipe, SetupActivity, SetupState, SetupTask, SetupTaskStatus } from '../shared/protocol.js';

export const RECIPE_FILE = join('.designer', 'run.json');

/** Runs a command, failing with the end of its output when it exits non-zero. */
export function runCommand(command: string, cwd: string, env: Record<string, string> = {}, timeoutMs = 10 * 60 * 1000): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1', npm_config_yes: 'true', ...env } });
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

const inside = (root: string, p: string) => {
  const rel = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('.git');
};

// ----- What Claude is asked -----

export interface PromptFacts {
  project: string;
  guess?: string;
  /** Why this is not the first try: the saved recipe failed, or the user asked again after a failure. */
  previousError?: string;
}

/** The one generic job Claude gets for any repo. */
export function buildSetupPrompt(f: PromptFacts): string {
  return [
    `Get the project at ${f.project} running so Designer can preview it and the user can design and edit it live.`,
    '',
    'Designer is a Figma-like canvas on top of this repo. It shows the running project in a frame on the canvas, and when the repo has Storybook it can also place single components from their stories. Your job is only to make the project run locally; do not build features or redesign anything.',
    '',
    'How to work:',
    '1. First call mcp__designer_setup__set_tasks with your plan: 3 to 6 short steps in plain words a designer understands (e.g. "Read how the project is built", "Install dependencies", "Start the app", "Start Storybook"). Call it again whenever a step starts, finishes, fails or is skipped, and when the plan changes. The user watches this list.',
    "2. Understand the repo quickly: README, package.json / pyproject / Gemfile / go.mod / Makefile / Procfile / docker-compose, framework config, monorepo layout, .env.example, .nvmrc / .tool-versions. Pick the app a designer would want to see (in a monorepo, the main web app or the UI package's Storybook).",
    "3. Prepare it with the repo's own tooling: the package manager its lockfile says, its own scripts, the runtime versions it pins. Install dependencies only if they are missing. Run prepare steps with Bash (they finish). If it needs environment variables, copy .env.example to the env file it reads and fill safe local placeholders; never invent real secrets.",
    '4. Start long-running servers ONLY with mcp__designer_setup__start_preview, never with Bash (a server never exits, so Bash would hang). Use kind "app" for the app and kind "storybook" for Storybook (add --ci and --no-open, e.g. `npm run storybook -- --ci --no-open -p $PORT`).',
    '   Designer gives each server a free port in $PORT: write $PORT in the command where the tool takes a port (e.g. `pnpm dev --port $PORT`, `python manage.py runserver $PORT`, `bin/rails s -p $PORT`). If the server prints no URL, pass url (e.g. "http://localhost:$PORT").',
    '   start_preview answers with the URL and whether it responds. If it fails, read the log it returns, fix the cause and try again. Never kill processes you did not start.',
    '5. If the repo has Storybook, start it too (single components render from stories). If it has no Storybook, do not add it.',
    '6. When it runs, call mcp__designer_setup__finish with what you found: a plain summary, the stack, the prepare commands that are needed on a fresh clone (with skipIf, a path that exists once the step is done, like "node_modules"), and notes a designer should know. If you cannot get it running, call finish with ok false and explain in plain words what is missing and what the user can do.',
    '',
    'Rules: stay inside the project folder; do not commit, push, switch branches or reset files; do not change source code beyond the minimum needed to run it locally (and say so in notes); keep each Bash command short-lived; be quick, this runs while the user waits.',
    '',
    `Facts: ${platform() === 'darwin' ? 'macOS' : platform()}. ${f.guess ? `Designer's quick guess from the files (may be wrong): ${f.guess}.` : ''}`,
    f.previousError ? `\nThe last attempt failed with:\n${f.previousError.slice(0, 2000)}\nStart from that.` : '',
  ]
    .join('\n')
    .trim();
}

export const SETUP_SYSTEM_PROMPT =
  "You are running inside Designer, a design tool on top of the user's repository. Designer asked you to get the project running for its canvas preview. Work fast and quietly, keep the task list current with set_tasks, start servers only with start_preview, and finish with finish. The user is often a designer: write task labels and the summary in plain words.";

// ----- Tools Claude gets for setup -----

const SETUP_TOOLS: ToolServer['tools'] = [
  {
    name: 'set_tasks',
    description: 'Show the user your setup plan and its progress. Send the whole list every time; it replaces the previous one.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short step in plain words, e.g. "Install dependencies"' },
              status: { type: 'string', enum: ['pending', 'running', 'done', 'skipped', 'failed'] },
              detail: { type: 'string', description: 'Optional: the command, or why it was skipped or failed' },
            },
            required: ['label', 'status'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'start_preview',
    description:
      'Start a long-running dev server (the app, or Storybook) in the background, owned by Designer, and wait until it serves. Returns its URL and whether it answers, or its last log lines if it failed. Starting the same kind again replaces the previous one. $PORT in command, url or env is a free port Designer picked.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['app', 'storybook'] },
        command: { type: 'string', description: "Shell command, e.g. 'pnpm dev --port $PORT' or 'npm run storybook -- --ci --no-open -p $PORT'" },
        cwd: { type: 'string', description: 'Folder to run it in, relative to the project (default ".")' },
        env: { type: 'object', description: 'Extra environment variables', additionalProperties: { type: 'string' } },
        url: { type: 'string', description: 'Only if the server prints no URL: the URL to wait for, e.g. "http://localhost:$PORT"' },
      },
      required: ['kind', 'command'],
    },
  },
  {
    name: 'finish',
    description: 'Report the result once the project runs (or cannot). Designer adapts itself to what you report and saves it so the next open is instant.',
    inputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string', description: 'One or two plain sentences: what this project is and how Designer previews it' },
        stack: { type: 'string', description: 'Short, e.g. "Next.js + Tailwind (pnpm)"' },
        prepare: {
          type: 'array',
          description: 'Commands a fresh clone needs before starting (install, codegen), in order',
          items: {
            type: 'object',
            properties: { command: { type: 'string' }, cwd: { type: 'string' }, skipIf: { type: 'string', description: 'Path (relative to the project) that exists once this step is done, e.g. "node_modules"' } },
            required: ['command'],
          },
        },
        notes: { type: 'array', items: { type: 'string' }, description: 'What a designer should know: stubbed env vars, pages worth opening, caveats, files you changed' },
        startPath: { type: 'string', description: 'Optional path in the app worth opening first, e.g. "/dashboard"' },
        problem: { type: 'string', description: 'When ok is false: what is missing and what the user can do, in plain words' },
      },
      required: ['ok', 'summary'],
    },
  },
];

/** Tools a setup run may use without asking. Anything else is refused, so a background run never waits on a prompt. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'WebFetch', 'WebSearch', 'ToolSearch'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];
/** Bash commands a setup run must not run: they change history, remote state or the machine. */
const FORBIDDEN = /\bsudo\b|\bgit\s+(push|reset|checkout|switch|clean|commit|rebase|stash|restore|merge|pull)\b|\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)|\bkill(all)?\b|\bpkill\b|\bshutdown\b|\breboot\b/;
/** Bash commands that start a server, which would never return. They go through start_preview instead. */
const SERVER = /^(\s*(cd\s+\S+\s*&&\s*)?)(npm\s+(run\s+)?(dev|start|serve|storybook)|pnpm\s+(run\s+)?(dev|start|serve|storybook)|yarn\s+(run\s+)?(dev|start|serve|storybook)|bun\s+(run\s+)?(dev|start|storybook)|npx\s+(vite|next\s+dev|storybook\s+dev)|next\s+dev|vite(\s|$)|storybook\s+dev|bin\/rails\s+s(erver)?|rails\s+s(erver)?|python3?\s+manage\.py\s+runserver|flask\s+run|uvicorn|php\s+artisan\s+serve|bin\/dev)\b/;

export function checkBash(command: string, runInBackground?: boolean): string | undefined {
  if (FORBIDDEN.test(command)) return 'Setup must not change git history, remote state or the machine. Leave that to the user.';
  if (SERVER.test(command) && !runInBackground) return 'That starts a server, which never exits. Start it with mcp__designer_setup__start_preview instead.';
  return undefined;
}

// ----- The runner -----

export interface RunnerHost {
  claudePath(): string | undefined;
  model?(): string | undefined;
  /** How the setup Claude reaches the setup tools (Designer's MCP endpoint for setup runs). */
  mcp(runId: string): Record<string, unknown>;
  app: DevProcess;
  storybook: DevProcess;
  publish(state: SetupState): void;
  /** A server is up: shows it on the canvas. */
  onUrl(kind: 'app' | 'storybook', url: string): void;
  /** Setup ended (done or failed). */
  onFinish?(state: SetupState): void;
  /** Tests: build the CLI another way. */
  makeCli?: (o: CliOptions) => Pick<ClaudeCli, 'ready' | 'sendUser' | 'close' | 'request'>;
  timeoutMs?: number;
}

interface Run {
  id: string;
  cwd: string;
  state: SetupState;
  started: { app?: RecipeCommand; storybook?: RecipeCommand };
  finished?: { ok: boolean; profile: ProjectProfile; prepare: RunRecipe['prepare']; problem?: string };
  cli?: Pick<ClaudeCli, 'close'>;
  cancelled: boolean;
}

export async function readRecipe(cwd: string): Promise<RunRecipe | undefined> {
  try {
    const r = JSON.parse(await readFile(join(cwd, RECIPE_FILE), 'utf8')) as RunRecipe;
    return r.version === 1 && (r.app || r.storybook) ? r : undefined;
  } catch {
    return undefined;
  }
}

async function writeRecipe(cwd: string, r: RunRecipe) {
  await mkdir(join(cwd, '.designer'), { recursive: true });
  await writeFile(join(cwd, RECIPE_FILE), JSON.stringify(r, null, 2) + '\n');
}

const sub = (s: string, port: number) => s.replace(/\$\{?PORT\}?/g, String(port));

/** What a tool call looks like in the activity list. */
export function describeActivity(name: string, input: Record<string, unknown>, cwd: string): { kind: SetupActivity['kind']; text: string } | undefined {
  const rel = (p: unknown) => (typeof p === 'string' ? (isAbsolute(p) ? relative(cwd, p) || p : p) : '');
  switch (name) {
    case 'Bash':
      return { kind: 'run', text: String(input.description || input.command || '').slice(0, 160) };
    case 'Read':
      return { kind: 'read', text: `Read ${rel(input.file_path)}` };
    case 'Glob':
      return { kind: 'search', text: `Look for ${String(input.pattern ?? '')}` };
    case 'Grep':
      return { kind: 'search', text: `Search for "${String(input.pattern ?? '')}"` };
    case 'LS':
      return { kind: 'search', text: `List ${rel(input.path) || 'the folder'}` };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return { kind: 'edit', text: `${name === 'Write' ? 'Write' : 'Edit'} ${rel(input.file_path)}` };
    case 'WebFetch':
      return { kind: 'web', text: `Open ${String(input.url ?? '')}` };
    case 'WebSearch':
      return { kind: 'web', text: `Search the web for "${String(input.query ?? '')}"` };
    case 'mcp__designer_setup__start_preview':
      return { kind: 'preview', text: `Start ${input.kind === 'storybook' ? 'Storybook' : 'the app'}: ${String(input.command ?? '')}` };
    case 'mcp__designer_setup__set_tasks':
    case 'mcp__designer_setup__finish':
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'ToolSearch':
      return undefined;
    default:
      return { kind: 'other', text: name.startsWith('mcp__') ? name.split('__').slice(2).join(' ').replace(/_/g, ' ') : name };
  }
}

/**
 * Gets an opened project running: replays the saved recipe when there is one, and otherwise (or when
 * that fails) asks Claude to work it out. Opening another project cancels a run in progress.
 */
export class ProjectRunner {
  private run?: Run;
  constructor(private readonly host: RunnerHost) {}

  get state(): SetupState | undefined {
    return this.run?.state;
  }

  get runId(): string | undefined {
    return this.run && !this.run.cancelled && this.run.state.status === 'running' ? this.run.id : undefined;
  }

  cancel() {
    if (!this.run) return;
    this.run.cancelled = true;
    this.run.cli?.close();
    this.run = undefined;
  }

  /** Starts setup for a project. `fresh` skips the saved recipe and asks Claude again. */
  async start(cwd: string, opts: { fresh?: boolean } = {}): Promise<SetupState> {
    const previous = this.run?.state;
    this.cancel();
    const run: Run = {
      id: randomUUID(),
      cwd,
      started: {},
      cancelled: false,
      state: { project: cwd, status: 'running', by: 'claude', tasks: [], activity: [], startedAt: Date.now() },
    };
    this.run = run;
    const recipe = opts.fresh ? undefined : await readRecipe(cwd);
    let previousError = previous?.project === cwd && previous.status === 'failed' ? previous.error : undefined;
    if (recipe) {
      const err = await this.replay(run, recipe);
      if (run.cancelled) return run.state;
      if (!err) return this.end(run, 'done');
      previousError = `Designer tried the saved way to run it (.designer/run.json) and it failed:\n${err}`;
    }
    await this.askClaude(run, previousError);
    return run.state;
  }

  private publish(run: Run) {
    if (!run.cancelled) this.host.publish(structuredClone(run.state));
  }

  private end(run: Run, status: 'done' | 'failed', error?: string) {
    if (run.cancelled) return run.state;
    for (const t of run.state.tasks) {
      if (t.status === 'running') t.status = status === 'done' ? 'done' : 'failed';
      if (t.status === 'pending') t.status = 'skipped';
    }
    for (const a of run.state.activity) if (a.status === 'running') a.status = status === 'done' ? 'done' : 'error';
    run.state.status = status;
    run.state.error = error;
    run.state.finishedAt = Date.now();
    this.publish(run);
    this.host.onFinish?.(structuredClone(run.state));
    return run.state;
  }

  private setTask(run: Run, id: string, label: string, status: SetupTaskStatus, detail?: string) {
    const t = run.state.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, { label, status, detail });
    else run.state.tasks.push({ id, label, status, detail });
    this.publish(run);
  }

  // ----- Fast path: the saved recipe -----

  private async replay(run: Run, r: RunRecipe): Promise<string | undefined> {
    run.state.by = 'saved';
    run.state.profile = r.profile;
    this.publish(run);
    try {
      for (const [i, p] of r.prepare.entries()) {
        const id = `prepare-${i}`;
        if (p.skipIf && existsSync(join(run.cwd, p.cwd ?? '.', p.skipIf))) {
          this.setTask(run, id, 'Prepare the project', 'skipped', `${p.command} (already done)`);
          continue;
        }
        this.setTask(run, id, 'Prepare the project', 'running', p.command);
        await runCommand(p.command, join(run.cwd, p.cwd ?? '.'), p.env);
        if (run.cancelled) return;
        this.setTask(run, id, 'Prepare the project', 'done', p.command);
      }
      for (const kind of ['app', 'storybook'] as const) {
        const c = r[kind];
        if (!c) continue;
        const label = kind === 'app' ? 'Start the app' : 'Start Storybook';
        this.setTask(run, kind, label, 'running', c.command);
        const res = await this.startPreview(run, { kind, ...c });
        if (run.cancelled) return;
        this.setTask(run, kind, label, 'done', res.url);
      }
      return undefined;
    } catch (e) {
      if (run.cancelled) return;
      const t = run.state.tasks.find((x) => x.status === 'running');
      if (t) t.status = 'failed';
      this.publish(run);
      return (e as Error).message;
    }
  }

  // ----- Starting servers (used by the replay and by Claude) -----

  private async startPreview(run: Run, a: { kind: 'app' | 'storybook'; command: string; cwd?: string; env?: Record<string, string>; url?: string }) {
    const dir = resolve(run.cwd, a.cwd || '.');
    if (!inside(run.cwd, dir)) throw new Error('cwd must be inside the project folder.');
    if (!existsSync(dir)) throw new Error(`There is no folder ${a.cwd} in the project.`);
    const dev = a.kind === 'storybook' ? this.host.storybook : this.host.app;
    const port = await freePort();
    const env: Record<string, string> = { PORT: String(port), BROWSER: 'none', NO_COLOR: '1' };
    for (const [k, v] of Object.entries(a.env ?? {})) env[k] = sub(String(v), port);
    const command = sub(a.command, port);
    const url = await dev.start(dir, command, env, a.url ? sub(a.url, port) : undefined);
    if (run.cancelled) return { url, answer: '' };
    const probe = a.kind === 'storybook' ? `${url}/index.json` : url;
    const answer = await fetch(probe, { signal: AbortSignal.timeout(30000) }).then(
      async (r) => (a.kind === 'storybook' && r.ok ? `answers, with ${Object.keys(((await r.json().catch(() => ({}))) as { entries?: object }).entries ?? {}).length} stories` : `answers with HTTP ${r.status}`),
      (e: Error) => `did not answer yet (${e.name === 'TimeoutError' ? 'still compiling after 30s' : e.message})`,
    );
    run.started[a.kind] = { command: a.command, cwd: relative(run.cwd, dir).replace(/\\/g, '/') || '.', ...(a.env && Object.keys(a.env).length ? { env: a.env } : {}) };
    if (a.kind === 'app') run.state.appUrl = url;
    else run.state.storybookUrl = url;
    this.publish(run);
    this.host.onUrl(a.kind, url);
    return { url, answer, tail: dev.tail(15) };
  }

  // ----- The tools Claude calls during setup -----

  tools(runId: string | undefined): ToolServer {
    return {
      name: 'designer_setup',
      instructions: 'Tools for getting the open project running inside Designer.',
      tools: SETUP_TOOLS,
      call: async (name, a) => {
        const run = this.run;
        if (!run || run.cancelled || run.id !== runId) throw new Error('This setup run was cancelled (the user opened another project). Stop now.');
        switch (name) {
          case 'set_tasks': {
            const list = Array.isArray(a.tasks) ? (a.tasks as Record<string, unknown>[]) : [];
            const statuses: SetupTaskStatus[] = ['pending', 'running', 'done', 'skipped', 'failed'];
            run.state.tasks = list.slice(0, 12).map((t, i): SetupTask => ({
              id: `t${i}`,
              label: String(t.label ?? '').slice(0, 80) || `Step ${i + 1}`,
              status: statuses.includes(t.status as SetupTaskStatus) ? (t.status as SetupTaskStatus) : 'pending',
              detail: t.detail ? String(t.detail).slice(0, 200) : undefined,
            }));
            this.publish(run);
            return 'Shown to the user.';
          }
          case 'start_preview': {
            const kind = a.kind === 'storybook' ? 'storybook' : 'app';
            if (!a.command) throw new Error('Give a command.');
            try {
              const r = await this.startPreview(run, { kind, command: String(a.command), cwd: a.cwd ? String(a.cwd) : undefined, env: a.env as Record<string, string> | undefined, url: a.url ? String(a.url) : undefined });
              return `${kind === 'app' ? 'The app' : 'Storybook'} is running at ${r.url} and ${r.answer}. It is on the canvas now.\nLast output:\n${r.tail}`;
            } catch (e) {
              throw new Error(`It did not start: ${(e as Error).message}`, { cause: e });
            }
          }
          case 'finish': {
            const ok = a.ok !== false;
            const preview: ProjectProfile['preview'] = run.started.app && run.started.storybook ? 'both' : run.started.app ? 'app' : run.started.storybook ? 'storybook' : 'none';
            if (ok && preview === 'none') throw new Error('Nothing is running yet. Start it with start_preview first, or call finish with ok false and explain what is missing.');
            const profile: ProjectProfile = {
              summary: String(a.summary ?? '').trim(),
              stack: String(a.stack ?? '').trim(),
              preview,
              components: run.started.storybook ? 'storybook' : run.started.app ? 'app' : 'none',
              notes: Array.isArray(a.notes) ? a.notes.map(String).filter(Boolean).slice(0, 8) : [],
              startPath: a.startPath ? String(a.startPath) : undefined,
            };
            const prepare = (Array.isArray(a.prepare) ? (a.prepare as Record<string, unknown>[]) : [])
              .filter((p) => p.command)
              .map((p) => ({ command: String(p.command), cwd: p.cwd ? String(p.cwd) : '.', ...(p.skipIf ? { skipIf: String(p.skipIf) } : {}) }));
            run.finished = { ok, profile, prepare, problem: a.problem ? String(a.problem) : undefined };
            run.state.profile = profile;
            this.publish(run);
            return ok ? 'Thanks. Designer saved how to run it. You are done; reply with one short sentence.' : 'Thanks. Designer will show the user what is missing. You are done.';
          }
          default:
            throw new Error(`Unknown tool ${name}`);
        }
      },
    };
  }

  // ----- Asking Claude -----

  private activity(run: Run, id: string, patch: Partial<SetupActivity> & { kind?: SetupActivity['kind']; text?: string }) {
    const a = run.state.activity.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
    else if (patch.text) run.state.activity.push({ id, kind: patch.kind ?? 'other', text: patch.text, status: patch.status ?? 'running' });
    if (run.state.activity.length > 60) run.state.activity.splice(0, run.state.activity.length - 60);
    this.publish(run);
  }

  private async askClaude(run: Run, previousError?: string) {
    run.state.by = 'claude';
    run.state.tasks = [{ id: 'read', label: 'Read how the project is built', status: 'running' }];
    this.publish(run);
    const claudePath = this.host.claudePath();
    if (!claudePath) return this.end(run, 'failed', 'Claude Code is not installed or not signed in, so Designer cannot set this project up.');

    const plan = await planProject(run.cwd).catch(() => undefined);
    const guess = plan && plan.framework !== 'unknown'
      ? `${plan.frameworkName} with ${plan.packageManager}${plan.appDir !== '.' ? ` in ${plan.appDir}` : ''}${plan.devCommand ? `, dev command "${plan.devCommand}"` : ''}${plan.needsInstall ? ', dependencies not installed' : ''}${plan.hasStorybook ? ', has Storybook' : ''}`
      : undefined;
    const prompt = buildSetupPrompt({ project: run.cwd, guess, previousError });

    let lastText = '';
    let cli!: Pick<ClaudeCli, 'ready' | 'sendUser' | 'close' | 'request'>;
    const result = new Promise<string>((done, fail) => {
      const timer = setTimeout(() => (cli?.close(), fail(new Error('Setup took longer than 15 minutes, so Designer stopped it.'))), this.host.timeoutMs ?? 15 * 60_000);
      const opts: CliOptions = {
        claudePath,
        cwd: run.cwd,
        model: this.host.model?.(),
        appendSystemPrompt: SETUP_SYSTEM_PROMPT,
        allowedTools: ['mcp__designer_setup'],
        onMessage: (m: CliMessage) => {
          if (run.cancelled) return;
          if (m.type === 'assistant') {
            const content = ((m.message as { content?: unknown[] })?.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
            for (const b of content) {
              if (b.type === 'text' && b.text?.trim()) {
                lastText = b.text.trim();
                run.state.message = lastText.split('\n')[0].slice(0, 200);
                this.publish(run);
              }
              if (b.type === 'tool_use' && b.name && b.id) {
                if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos) && !run.state.tasks.some((t) => t.id.startsWith('t'))) {
                  // Claude used its own todo list instead of set_tasks: show that.
                  run.state.tasks = (b.input.todos as { content?: string; activeForm?: string; status?: string }[]).map((t, i) => ({
                    id: `todo${i}`,
                    label: String(t.content ?? '').slice(0, 80),
                    status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'pending',
                  }));
                  this.publish(run);
                }
                const d = describeActivity(b.name, b.input ?? {}, run.cwd);
                if (d) this.activity(run, b.id, { ...d, status: 'running' });
              }
            }
          }
          if (m.type === 'user') {
            const content = ((m.message as { content?: unknown })?.content ?? []) as { type: string; tool_use_id?: string; is_error?: boolean }[];
            if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_result' && b.tool_use_id) this.activity(run, b.tool_use_id, { status: b.is_error ? 'error' : 'done' });
          }
          if (m.type === 'result') {
            clearTimeout(timer);
            const text = typeof m.result === 'string' && m.result.trim() ? m.result.trim() : lastText;
            if (m.subtype === 'success' && !m.is_error) done(text);
            else fail(new Error(text || String(m.subtype ?? 'Claude Code could not finish')));
          }
        },
        onPermission: async ({ toolName, input }) => {
          if (toolName.startsWith('mcp__designer_setup__') || READ_TOOLS.includes(toolName)) return { behavior: 'allow' };
          if (toolName === 'Bash') {
            const why = checkBash(String(input.command ?? ''), !!input.run_in_background);
            return why ? { behavior: 'deny', message: why } : { behavior: 'allow' };
          }
          if (EDIT_TOOLS.includes(toolName)) {
            const p = String(input.file_path ?? '');
            return p && inside(run.cwd, p) ? { behavior: 'allow' } : { behavior: 'deny', message: 'Setup only changes files inside the project.' };
          }
          return { behavior: 'deny', message: `Setup does not use ${toolName}.` };
        },
        onExit: (code, stderr) => {
          clearTimeout(timer);
          fail(new Error(`Claude Code stopped${code !== null ? ` (exit ${code})` : ''}. ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim()));
        },
      };
      cli = this.host.makeCli ? this.host.makeCli(opts) : new ClaudeCli(opts);
      run.cli = cli;
    });
    result.catch(() => undefined);

    let final: string;
    try {
      await cli.ready;
      if (run.cancelled) return;
      await cli.request({ subtype: 'mcp_set_servers', servers: { designer_setup: this.host.mcp(run.id) } }).catch(() => undefined);
      cli.sendUser(prompt);
      final = await result;
    } catch (e) {
      cli.close();
      if (run.cancelled) return;
      // Claude stopped, but servers it started may be fine: keep them, and say what happened.
      return this.end(run, 'failed', (e as Error).message);
    }
    cli.close();
    if (run.cancelled) return;

    const f = run.finished;
    if (f && !f.ok) return this.end(run, 'failed', f.problem || f.profile.summary || final);
    if (!run.started.app && !run.started.storybook) return this.end(run, 'failed', final || 'Claude finished without starting the project.');
    const profile: ProjectProfile = f?.profile ?? {
      summary: final.split('\n')[0] ?? '',
      stack: guess ?? '',
      preview: run.started.app && run.started.storybook ? 'both' : run.started.app ? 'app' : 'storybook',
      components: run.started.storybook ? 'storybook' : 'app',
      notes: [],
    };
    run.state.profile = profile;
    await writeRecipe(run.cwd, { version: 1, prepare: f?.prepare ?? [], app: run.started.app, storybook: run.started.storybook, profile, savedAt: new Date().toISOString() }).catch(() => undefined);
    return this.end(run, 'done');
  }
}

/** One line for the chat Claude, so it knows how this project runs in Designer. */
export function describeSetup(s: SetupState): string {
  const p = s.profile;
  if (s.status === 'failed') return `Designer's setup could not get ${s.project} running. ${s.error ?? ''}`.trim();
  const where = [s.appUrl && `the app at ${s.appUrl}`, s.storybookUrl && `Storybook at ${s.storybookUrl}`].filter(Boolean);
  return [
    `Designer set up ${s.project}: ${where.join(' and ')} ${where.length > 1 ? 'are' : 'is'} running and on the canvas.`,
    p?.summary && `What it is: ${p.summary}`,
    p?.stack && `Stack: ${p.stack}`,
    p && `Preview: ${p.components === 'storybook' ? 'single components render from Storybook stories (show_component), and the app frame shows whole pages' : 'the running app is the preview; edits to the code show up in the app frame live. There is no Storybook, so show_component is not available.'}`,
    p?.notes.length ? `Notes: ${p.notes.join(' ')}` : '',
  ]
    .filter(Boolean)
    // One line: chat notes are single "[Designer] ..." lines.
    .join(' ');
}
