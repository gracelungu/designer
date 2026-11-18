// Smoke test: the real Designer server, a copy of a small repo and a stand-in Figma desktop server,
// driven over HTTP the way the UI and Claude drive it.
import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/index';
import type { TokenReport } from '../src/shared/tokenSync';
import { fakeFigma } from './fixtures/fakeFigma';

const FIGMA_VARS = { 'Color/Primary': '#2563EB', 'Color/Surface': '#FFFFFF', 'Radius/Card': '12', 'Space/4': '16', 'Color/Success': '#16A34A', 'Brand/500': '#6D28D9' };

describe('smoke: Figma variables and code tokens through the server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let figma: Awaited<ReturnType<typeof fakeFigma>>;
  let repo: string;
  const call = async <T,>(path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const r = await fetch(`${server.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-designer-token': server.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: (await r.json()) as T };
  };

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'designer-smoke-')));
    cpSync(join(__dirname, 'fixtures', 'token-repo'), repo, { recursive: true });
    figma = await fakeFigma({ selection: '', variables: JSON.stringify(FIGMA_VARS) });
    process.env.DESIGNER_CLAUDE_PATH = join(__dirname, 'fixtures', 'fake-claude.mjs');
    server = await startServer({ port: 0, initialProject: repo, workspace: mkdtempSync(join(tmpdir(), 'designer-ws-')), figmaUrls: [figma.url] });
  });
  afterAll(async () => {
    server?.close();
    await figma?.close();
  });

  it('lists code tokens before anything comes from Figma', async () => {
    const { status, data } = await call<TokenReport>('/api/tokens/sync');
    expect(status).toBe(200);
    expect(data.figma).toBeNull();
    expect(data.pairs.length).toBeGreaterThan(10);
    expect(data.pairs.some((p) => p.code?.source === 'tailwind')).toBe(true);
  });

  it('pulls variables from the Figma desktop server and reports drift', async () => {
    const { status, data } = await call<TokenReport>('/api/tokens/sync/figma', {});
    expect(status).toBe(200);
    expect(data.figma).toMatchObject({ source: 'figma-desktop', count: 6 });
    expect(data.summary).toMatchObject({ drift: 2, figmaOnly: 1 });
    expect(data.pairs.filter((p) => p.status === 'drift').map((p) => p.key).sort()).toEqual(['Brand/500', 'Radius/Card']);
    expect(JSON.parse(readFileSync(join(repo, '.designer', 'figma-variables.json'), 'utf8')).variables).toHaveLength(6);
  });

  it('gives Claude the same picture through the designer MCP server', async () => {
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'x-designer-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_design_tokens', arguments: { status: 'drift' } } }),
    });
    const out = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(out.result.isError).toBeFalsy();
    const body = JSON.parse(out.result.content[0].text) as { summary: { drift: number }; tokens: { status: string; figma: string; code: string }[] };
    expect(body.summary.drift).toBe(2);
    expect(body.tokens.map((t) => t.figma).sort()).toEqual(['Brand/500 = #6D28D9', 'Radius/Card = 12']);
    expect(body.tokens.find((t) => t.figma.startsWith('Radius'))!.code).toMatch(/--radius-card = 8px \(src\/styles\/tokens\.css:8/);
  });

  it('fixes drift by writing Figma values into the CSS and the Tailwind config', async () => {
    const { status, data } = await call<TokenReport>('/api/tokens/sync/use-figma', { keys: ['Radius/Card', 'Brand/500'] });
    expect(status).toBe(200);
    expect(data.summary.drift).toBe(0);
    expect(readFileSync(join(repo, 'src', 'styles', 'tokens.css'), 'utf8')).toContain('--radius-card: 12px;');
    expect(readFileSync(join(repo, 'tailwind.config.ts'), 'utf8')).toContain('500: "#6d28d9",');
  });

  it('links a Figma variable to a token with another name', async () => {
    const { data } = await call<TokenReport>('/api/tokens/sync/link', { figma: 'Color/Success', code: 'colors.danger' });
    expect(data.links).toEqual({ 'Color/Success': 'colors.danger' });
    expect(data.pairs.find((p) => p.key === 'Color/Success')).toMatchObject({ status: 'drift', match: 'linked' });
    await call('/api/tokens/sync/link', { figma: 'Color/Success', code: null });
  });

  it('imports a Figma REST variables file in place of the pulled ones', async () => {
    const text = readFileSync(join(repo, 'figma-variables.rest.json'), 'utf8');
    const { data } = await call<TokenReport>('/api/tokens/sync/import', { text });
    expect(data.figma).toMatchObject({ source: 'import', count: 10 });
    expect(data.pairs.find((p) => p.key === 'Color/Surface@Dark')!.status).toBe('drift');
  });

  it('answers errors as messages, not crashes', async () => {
    expect((await call<{ error: string }>('/api/tokens/sync/import', { text: '[1,2' })).data.error).toMatch(/Figma variables/);
    expect((await call<{ error: string }>('/api/tokens/sync/use-figma', { key: 'Nope' })).status).toBe(400);
    const anon = await fetch(`${server.url}/api/tokens/sync`);
    expect(anon.status).toBe(403);
  });
});
