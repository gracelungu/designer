// Smoke test: the real Designer server, a real fixture repo copied to a temp folder, a real
// `npm install` (of a local file: dependency, so it works offline) and real dev servers.
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index';
import { AutoSetup } from '../src/server/autosetup';
import { DevProcess } from '../src/server/project';
import type { ComponentEntry, SetupState } from '../src/shared/protocol';

const fx = (name: string) => join(__dirname, 'fixtures', 'projects', name);
const copy = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `designer-${name}-`));
  cpSync(fx(name), dir, { recursive: true });
  return dir;
};

async function boot() {
  const srv = await startServer({ port: 0, token: 'smoke', workspace: mkdtempSync(join(tmpdir(), 'designer-ws-')) });
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${srv.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-designer-token': 'smoke', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const settled = async () => {
    for (let i = 0; i < 600; i++) {
      const s = await call<SetupState | null>('/api/project/setup');
      if (s && s.status !== 'running') return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('setup did not finish');
  };
  return { srv, call, settled };
}

const servers: { close: () => void }[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe('smoke: adding a project sets it up with no configuration', () => {
  it('installs, starts the dev server and Storybook, and indexes components', async () => {
    const dir = copy('runnable');
    const { srv, call, settled } = await boot();
    servers.push(srv);
    const info = await call<{ components: ComponentEntry[] }>('/api/project', { path: dir });
    expect(info.components.map((c) => c.name)).toEqual(['Pill', 'Unstoried']);

    const s = await settled();
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('done');
    expect(Object.fromEntries(s.steps.map((x) => [x.id, x.status]))).toEqual({ detect: 'done', index: 'done', install: 'done', start: 'done', storybook: 'done' });
    expect(s.plan).toMatchObject({ framework: 'node', packageManager: 'npm', devCommand: 'npm run dev', needsInstall: true });
    expect(s.steps.find((x) => x.id === 'index')!.detail).toBe('2 components, 1 with stories');
    expect(existsSync(join(dir, 'node_modules', 'local-dep'))).toBe(true);

    // The dev server really answers, and Designer reports it.
    expect(await (await fetch(s.appUrl!)).text()).toContain('runnable app');
    expect((await call<{ app: string }>('/api/run')).app).toBe(s.appUrl);
    // Storybook was started and lists this project's stories.
    expect(await (await fetch(`${s.storybookUrl}/index.json`)).text()).toContain('Pill.stories.tsx');
    const comps = await call<ComponentEntry[]>('/api/components');
    expect(comps.find((c) => c.name === 'Pill')!.storyIds).toEqual(['inputs-pill--default']);

    // Running setup again reuses the running server rather than starting another.
    const again = await call<SetupState>('/api/project/setup', {});
    expect(again.appUrl).toBe(s.appUrl);
    expect(again.steps.find((x) => x.id === 'install')!.status).toBe('skipped');

    // Closing the project stops what Designer started.
    await call('/api/project/close', {});
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(s.appUrl!)).rejects.toThrow();
  }, 120000);

  it('serves a plain HTML folder by itself', async () => {
    const { srv, call, settled } = await boot();
    servers.push(srv);
    await call('/api/project', { path: copy('static-html') });
    const s = await settled();
    expect(s.status).toBe('done');
    expect(s.steps.find((x) => x.id === 'install')!.status).toBe('skipped');
    expect(await (await fetch(s.appUrl!)).text()).toContain('Hello static');
  }, 60000);

  it('reports a dev server that crashes, with its output, and can try again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'designer-broken-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "console.error(\'Cannot find module vite\'); process.exit(1)"' } }));
    const { srv, call, settled } = await boot();
    servers.push(srv);
    await call('/api/project', { path: dir });
    const s = await settled();
    expect(s.status).toBe('failed');
    expect(s.steps.find((x) => x.id === 'start')!.status).toBe('failed');
    expect(s.steps.find((x) => x.id === 'storybook')!.status).toBe('skipped');
    expect(s.error).toContain('Cannot find module vite');
    // Fixed (say, by Claude), then retried.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
    cpSync(join(fx('runnable'), 'server.cjs'), join(dir, 'server.cjs'));
    const retry = await call<SetupState>('/api/project/setup', {});
    expect(retry.status).toBe('done');
  }, 60000);

  it('can be turned off per request', async () => {
    const { srv, call } = await boot();
    servers.push(srv);
    await call('/api/project', { path: copy('static-html'), setup: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(await call('/api/project/setup')).toBeNull();
  });
});

describe('AutoSetup', () => {
  const host = (over: Partial<Parameters<AutoSetup['run']>[1]> = {}) => {
    const states: SetupState[] = [];
    return { states, host: { app: new DevProcess('dev'), publish: (s: SetupState) => states.push(s), onAppUrl: () => undefined, ...over } };
  };

  it('stops at a failed install and says why', async () => {
    const { states, host: h } = host({ install: async () => Promise.reject(new Error('ERR_PNPM_NO_NETWORK')) });
    const s = await new AutoSetup().run(fx('next-pnpm'), h);
    expect(s.status).toBe('failed');
    expect(s.error).toBe('ERR_PNPM_NO_NETWORK');
    expect(s.steps.map((x) => x.status)).toEqual(['done', 'done', 'failed', 'skipped', 'skipped']);
    expect(states[0].steps.every((x) => x.status === 'pending')).toBe(true);
  });

  it('installs a monorepo at its root and runs the app package', async () => {
    const calls: string[] = [];
    let started = '';
    const app = new DevProcess('dev');
    app.start = async (cwd, cmd, env) => ((started = `${cwd} :: ${cmd} :: PORT=${env?.PORT}`), 'http://localhost:1');
    const { host: h } = host({ app, install: async (cmd, cwd) => void calls.push(`${cmd} @ ${cwd}`) });
    const s = await new AutoSetup().run(fx('monorepo-pnpm'), h);
    expect(s.status).toBe('done');
    expect(calls).toEqual([`pnpm install @ ${fx('monorepo-pnpm')}`]);
    expect(started).toMatch(new RegExp(`apps/web :: pnpm run dev :: PORT=\\d+$`));
  });

  it('a newer run (another project opened) cancels the older one', async () => {
    const setup = new AutoSetup();
    let release!: () => void;
    const { states, host: h } = host({ install: () => new Promise<void>((r) => (release = r)) });
    const first = setup.run(fx('next-pnpm'), h);
    await new Promise((r) => setTimeout(r, 50));
    setup.cancel();
    release();
    await first;
    expect(states.at(-1)!.steps.find((x) => x.id === 'install')!.status).toBe('running');
    expect(setup.state).toBeUndefined();
  });
});
