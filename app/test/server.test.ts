// The local server end to end over HTTP, as the UI and the Mac app use it.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index';

const DEMO = join(__dirname, '..', 'demo');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'designer-server-')));

let srv: Awaited<ReturnType<typeof startServer>>;
let workspace: string;
const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${srv.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-designer-token': srv.token, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  process.env.DESIGNER_CLAUDE_PATH = join(__dirname, 'fixtures', 'fake-claude.mjs');
  workspace = join(tmp(), 'Designer');
  srv = await startServer({ workspace, demoDir: DEMO });
});
afterAll(() => srv.close());

describe('server security', () => {
  it('needs the per-run token', async () => {
    expect((await call('/api/status', undefined, { 'x-designer-token': 'wrong' })).status).toBe(403);
  });
  it('only answers loopback hosts', async () => {
    // fetch cannot fake the Host header, so use a raw request, as a DNS-rebinding page would.
    const status = await new Promise<number>((resolve, reject) => {
      request(`${srv.url}/api/status`, { headers: { host: 'evil.example', 'x-designer-token': srv.token } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject).end();
    });
    expect(status).toBe(403);
  });
  it('rejects invalid JSON and keeps serving requests', async () => {
    for (const body of ['{', 'null', '[]']) {
      const res = await fetch(`${srv.url}/api/canvas`, {
        method: 'POST',
        headers: { 'x-designer-token': srv.token, 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect((await call('/api/status')).status).toBe(200);
  });

  it('404s unknown routes', async () => {
    expect((await call('/api/nope')).status).toBe(404);
  });
});

describe('first run', () => {
  it('reports Claude Code, the demo and that onboarding is not done', async () => {
    const { data } = await call('/api/status');
    expect(data.claude).toMatchObject({ found: true, version: '9.9.9', loggedIn: true });
    expect(data.demo).toBe(true);
    expect(data.onboarded).toBe(false);
    expect(data.workspace).toBe(workspace);
  });

  it('remembers onboarding, and can show it again', async () => {
    expect((await call('/api/onboarding', { startedWith: 'demo' })).data.startedWith).toBe('demo');
    expect((await call('/api/status')).data.onboarded).toBe(true);
    // A bogus choice is not stored.
    expect((await call('/api/onboarding', { startedWith: 'rm -rf' })).data.startedWith).toBeUndefined();
    await call('/api/onboarding/reset', {});
    expect((await call('/api/status')).data.onboarded).toBe(false);
  });

  it('keeps onboarding done across restarts', async () => {
    await call('/api/onboarding', { startedWith: 'blank' });
    const again = await startServer({ workspace, demoDir: DEMO });
    try {
      const res = await fetch(`${again.url}/api/status`, { headers: { 'x-designer-token': again.token } });
      expect(((await res.json()) as { onboarded: boolean }).onboarded).toBe(true);
    } finally {
      again.close();
    }
  });
});

describe('demo project', () => {
  it('opens a copy of the demo as the project', async () => {
    const { status, data } = await call('/api/demo', {});
    expect(status).toBe(200);
    expect(data.path).toBe(join(workspace, 'Lumen demo'));
    expect(data.name).toBe('Lumen demo');
    expect(data.scripts.storybook).toBeTruthy();
    expect(data.stories.length).toBe(3);
    expect((await call('/api/status')).data.project).toBe(data.path);
  });

  it('lists and edits the demo tokens', async () => {
    const tokens = (await call('/api/tokens')).data as unknown as { name: string; file: string; line: number }[];
    const primary = tokens.find((t) => t.name === '--color-primary')!;
    await call('/api/tokens', { file: primary.file, line: primary.line, name: primary.name, value: '#2244ff' });
    expect(readFileSync(join(workspace, 'Lumen demo', primary.file), 'utf8')).toContain('--color-primary: #2244ff;');
  });

  it('saves the canvas inside the project', async () => {
    await call('/api/canvas', { data: { layers: [1, 2] } });
    expect(existsSync(join(workspace, 'Lumen demo', '.designer', 'canvas.json'))).toBe(true);
    expect((await call('/api/canvas')).data.data).toEqual({ layers: [1, 2] });
  });

  it('saves a version with git', async () => {
    const r = await call('/api/git/save', { message: 'Bluer primary' });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    const info = (await call('/api/project')).data;
    expect(info.git.lastCommit).toBe('Bluer primary');
    expect(info.git.changed).toEqual([]);
  });

  it('closes the project and falls back to the workspace', async () => {
    await call('/api/project/close', {});
    expect((await call('/api/status')).data.project).toBeNull();
    expect((await call('/api/tokens')).status).toBe(400);
  });

  it('says so when a build has no demo', async () => {
    const bare = await startServer({ workspace: join(tmp(), 'W') });
    try {
      const res = await fetch(`${bare.url}/api/demo`, { method: 'POST', headers: { 'x-designer-token': bare.token, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(404);
      const st = await fetch(`${bare.url}/api/status`, { headers: { 'x-designer-token': bare.token } }).then((r) => r.json());
      expect((st as { demo: boolean }).demo).toBe(false);
    } finally {
      bare.close();
    }
  });
});

describe('Claude Code through the server', () => {
  it('reads models, commands and MCP servers from the CLI', async () => {
    const { data } = await call('/api/capabilities');
    expect(data.claudeVersion).toBe('9.9.9');
    expect(data.commands.map((c: { name: string }) => c.name)).toContain('my-skill');
    expect(data.modes.map((m: { value: string }) => m.value)).toContain('plan');
  });
});
