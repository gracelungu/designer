// Setup by Claude: opening a project hands the local Claude Code one generic job (understand the repo, get
// it running), streams its steps as tasks, and saves what worked so the next open replays it without Claude.
// Claude here is the fake CLI (test/fixtures/fake-claude.mjs) following a script, against a real fixture
// repo, a real `npm install` (of a local file: dependency, so it works offline) and real dev servers.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index';
import { buildSetupPrompt, checkBash, describeActivity, describeSetup } from '../src/server/runner';
import type { RunRecipe, SetupState } from '../src/shared/protocol';

const fx = (name: string) => join(__dirname, 'fixtures', 'projects', name);
const copy = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `designer-${name}-`)));
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
  const settled = async (since = 0) => {
    for (let i = 0; i < 600; i++) {
      const s = await call<SetupState | null>('/api/project/setup');
      if (s && s.status !== 'running' && s.startedAt > since) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('setup did not finish');
  };
  servers.push(srv);
  return { srv, call, settled };
}

/** What the fake Claude does: plan, look, install, try a server in Bash (refused), start it properly, finish. */
const script = (extra: object[] = []) =>
  JSON.stringify([
    { tool: 'mcp__designer_setup__set_tasks', input: { tasks: [{ label: 'Read how the project is built', status: 'running' }, { label: 'Install dependencies', status: 'pending' }, { label: 'Start the app', status: 'pending' }] } },
    { tool: 'Read', input: { file_path: 'package.json' } },
    { tool: 'Bash', input: { command: 'npm install --no-audit --no-fund', description: 'Install dependencies' } },
    { tool: 'Bash', input: { command: 'npm run dev' } },
    { tool: 'mcp__designer_setup__set_tasks', input: { tasks: [{ label: 'Read how the project is built', status: 'done' }, { label: 'Install dependencies', status: 'done' }, { label: 'Start the app', status: 'running' }] } },
    { tool: 'mcp__designer_setup__start_preview', input: { kind: 'app', command: 'npm run dev' } },
    { tool: 'mcp__designer_setup__start_preview', input: { kind: 'storybook', command: 'node storybook.cjs --port $PORT' } },
    ...extra,
    {
      tool: 'mcp__designer_setup__finish',
      input: { ok: true, summary: 'A tiny test app.', stack: 'Node (npm)', prepare: [{ command: 'npm install', skipIf: 'node_modules' }], notes: ['Nothing to stub.'] },
    },
  ]);

const servers: { close: () => void }[] = [];
const env = { ...process.env };
beforeAll(() => {
  process.env.DESIGNER_CLAUDE_PATH = join(__dirname, 'fixtures', 'fake-claude.mjs');
});
afterAll(() => {
  servers.forEach((s) => s.close());
  process.env = env;
});

describe('setup by Claude', () => {
  it('gets any repo running from one generic prompt, streams its steps, and saves what worked', async () => {
    const dir = copy('runnable');
    const promptOut = join(mkdtempSync(join(tmpdir(), 'designer-prompt-')), 'p.json');
    process.env.FAKE_CLAUDE_SETUP = script();
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    const { call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    delete process.env.FAKE_CLAUDE_PROMPT_OUT;

    expect(s.error).toBeUndefined();
    expect(s.status).toBe('done');
    expect(s.by).toBe('claude');
    // Claude's own plan is the task list, all finished.
    expect(s.tasks.map((t) => [t.label, t.status])).toEqual([
      ['Read how the project is built', 'done'],
      ['Install dependencies', 'done'],
      ['Start the app', 'done'],
    ]);
    // Every command it ran is in the activity log; a server started in Bash was refused.
    expect(s.activity.map((a) => [a.kind, a.text, a.status])).toEqual([
      ['read', 'Read package.json', 'done'],
      ['run', 'Install dependencies', 'done'],
      ['run', 'npm run dev', 'error'],
      ['preview', 'Start the app: npm run dev', 'done'],
      ['preview', 'Start Storybook: node storybook.cjs --port $PORT', 'done'],
    ]);
    expect(existsSync(join(dir, 'node_modules', 'local-dep'))).toBe(true);

    // The servers really answer, and the window knows them.
    expect(await (await fetch(s.appUrl!)).text()).toContain('runnable app');
    expect((await call<{ app: string; storybook: string }>('/api/run')).app).toBe(s.appUrl);
    expect((await call<{ storybook: string }>('/api/run')).storybook).toBe(s.storybookUrl);

    // The app adapts to what Claude found.
    expect(s.profile).toMatchObject({ summary: 'A tiny test app.', stack: 'Node (npm)', preview: 'both', components: 'storybook', notes: ['Nothing to stub.'] });

    // The prompt is generic: it asks Claude to understand the repo and run it, whatever it is.
    const { prompt, args } = JSON.parse(readFileSync(promptOut, 'utf8')) as { prompt: string; args: string[] };
    expect(prompt).toContain(`Get the project at ${dir} running`);
    expect(prompt).toContain('start_preview');
    expect(args).toContain('mcp__designer_setup');

    // What worked is saved for next time, with $PORT kept so a fresh port is used each run.
    const recipe = JSON.parse(readFileSync(join(dir, '.designer', 'run.json'), 'utf8')) as RunRecipe;
    expect(recipe).toMatchObject({ version: 1, prepare: [{ command: 'npm install', cwd: '.', skipIf: 'node_modules' }], app: { command: 'npm run dev', cwd: '.' }, storybook: { command: 'node storybook.cjs --port $PORT', cwd: '.' } });

    // Closing the project stops what Designer started.
    await call('/api/project/close', {});
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(s.appUrl!)).rejects.toThrow();
  }, 120000);

  it('replays the saved recipe on the next open, without Claude', async () => {
    const dir = copy('runnable');
    process.env.FAKE_CLAUDE_SETUP = script();
    const first = await boot();
    await first.call('/api/project', { path: dir });
    expect((await first.settled()).status).toBe('done');
    first.srv.close();

    // Claude would fail now; the saved way does not need it.
    process.env.FAKE_CLAUDE_SETUP = '[]';
    const { call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    expect(s.status).toBe('done');
    expect(s.by).toBe('saved');
    expect(s.tasks.map((t) => [t.label, t.status])).toEqual([
      ['Prepare the project', 'skipped'],
      ['Start the app', 'done'],
      ['Start Storybook', 'done'],
    ]);
    expect(s.profile?.stack).toBe('Node (npm)');
    expect(await (await fetch(s.appUrl!)).text()).toContain('runnable app');
  }, 120000);

  it('falls back to Claude when the saved way stops working', async () => {
    const dir = copy('runnable');
    const recipe: RunRecipe = { version: 1, prepare: [], app: { command: 'node gone.cjs', cwd: '.' }, profile: { summary: '', stack: 'old', preview: 'app', components: 'app', notes: [] }, savedAt: '' };
    mkdirSync(join(dir, '.designer'), { recursive: true });
    writeFileSync(join(dir, '.designer', 'run.json'), JSON.stringify(recipe));
    const promptOut = join(mkdtempSync(join(tmpdir(), 'designer-prompt-')), 'p.json');
    process.env.FAKE_CLAUDE_SETUP = script();
    process.env.FAKE_CLAUDE_PROMPT_OUT = promptOut;
    const { call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    delete process.env.FAKE_CLAUDE_PROMPT_OUT;
    expect(s.status).toBe('done');
    expect(s.by).toBe('claude');
    // Claude was told what failed.
    expect(JSON.parse(readFileSync(promptOut, 'utf8')).prompt).toContain('node gone.cjs');
  }, 120000);

  it("shows Claude's explanation when it cannot get the project running", async () => {
    const dir = copy('static-html');
    process.env.FAKE_CLAUDE_SETUP = JSON.stringify([
      { tool: 'mcp__designer_setup__finish', input: { ok: false, summary: 'A Rails app.', problem: 'It needs Ruby 3.3, which is not installed. Install it with rbenv, then try again.' } },
    ]);
    const { call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('It needs Ruby 3.3, which is not installed. Install it with rbenv, then try again.');
    expect(existsSync(join(dir, '.designer', 'run.json'))).toBe(false);
  }, 60000);

  it('fails clearly when Claude ends without starting anything, and can try again', async () => {
    const dir = copy('runnable');
    process.env.FAKE_CLAUDE_SETUP = '[]';
    process.env.FAKE_CLAUDE_SUMMARY = 'I could not find a way to run this.';
    const { call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    delete process.env.FAKE_CLAUDE_SUMMARY;
    expect(s.status).toBe('failed');
    expect(s.error).toBe('I could not find a way to run this.');

    process.env.FAKE_CLAUDE_SETUP = script();
    await call('/api/project/setup', { fresh: true });
    const again = await settled(s.startedAt);
    expect(again.status).toBe('done');
  }, 120000);

  it('refuses a server start outside the project, and tools from a cancelled run', async () => {
    const dir = copy('runnable');
    process.env.FAKE_CLAUDE_SETUP = JSON.stringify([
      { tool: 'mcp__designer_setup__start_preview', input: { kind: 'app', command: 'npm run dev', cwd: '..' } },
      { tool: 'mcp__designer_setup__finish', input: { ok: true, summary: 'x' } },
    ]);
    const { srv, call, settled } = await boot();
    await call('/api/project', { path: dir });
    const s = await settled();
    expect(s.activity[0]).toMatchObject({ kind: 'preview', status: 'error' });
    expect(s.status).toBe('failed');
    // A stale run id gets nothing.
    const r = await fetch(`${srv.url}/mcp/setup`, {
      method: 'POST',
      headers: { 'x-designer-token': 'smoke', 'x-designer-run': 'old', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_preview', arguments: { kind: 'app', command: 'npm run dev' } } }),
    });
    expect(((await r.json()) as { result: { isError: boolean } }).result.isError).toBe(true);
  }, 60000);

  it('can be turned off per request', async () => {
    const { call } = await boot();
    await call('/api/project', { path: copy('static-html'), setup: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(await call('/api/project/setup')).toBeNull();
  });
});

describe('setup rules', () => {
  it('keeps servers out of Bash and git history untouched', () => {
    expect(checkBash('npm install')).toBeUndefined();
    expect(checkBash('pnpm install --frozen-lockfile')).toBeUndefined();
    expect(checkBash('cp .env.example .env.local')).toBeUndefined();
    expect(checkBash('npm run build')).toBeUndefined();
    expect(checkBash('npm run dev')).toMatch(/start_preview/);
    expect(checkBash('cd web && pnpm dev')).toMatch(/start_preview/);
    expect(checkBash('python manage.py runserver 8000')).toMatch(/start_preview/);
    expect(checkBash('npm run dev', true)).toBeUndefined();
    expect(checkBash('git push origin main')).toMatch(/git history/);
    expect(checkBash('git checkout -- .')).toMatch(/git history/);
    expect(checkBash('sudo npm i -g pnpm')).toMatch(/git history|machine/);
    expect(checkBash('git status')).toBeUndefined();
  });

  it('says what Claude is doing in plain words', () => {
    expect(describeActivity('Bash', { command: 'pnpm i', description: 'Install dependencies' }, '/p')).toEqual({ kind: 'run', text: 'Install dependencies' });
    expect(describeActivity('Read', { file_path: '/p/README.md' }, '/p')).toEqual({ kind: 'read', text: 'Read README.md' });
    expect(describeActivity('mcp__designer_setup__set_tasks', {}, '/p')).toBeUndefined();
  });

  it('asks for any stack, not only Storybook', () => {
    const p = buildSetupPrompt({ project: '/x', guess: 'Vite with npm' });
    expect(p).toContain('README');
    expect(p).toMatch(/Gemfile|pyproject/);
    expect(p).toContain('If it has no Storybook, do not add it');
    expect(p).toContain("Designer's quick guess from the files (may be wrong): Vite with npm.");
    expect(buildSetupPrompt({ project: '/x', previousError: 'boom' })).toContain('The last attempt failed with:\nboom');
  });

  it('tells the chat Claude how this project previews', () => {
    const base: SetupState = { project: '/p', status: 'done', by: 'claude', tasks: [], activity: [], startedAt: 0, appUrl: 'http://localhost:5173' };
    const appOnly = describeSetup({ ...base, profile: { summary: 'A shop.', stack: 'Next.js', preview: 'app', components: 'app', notes: [] } });
    expect(appOnly).toContain('the app at http://localhost:5173 is running');
    expect(appOnly).toContain('show_component is not available');
    const both = describeSetup({ ...base, storybookUrl: 'http://localhost:6006', profile: { summary: '', stack: '', preview: 'both', components: 'storybook', notes: [] } });
    expect(both).toContain('are running');
    expect(both).toContain('Storybook stories');
  });
});
