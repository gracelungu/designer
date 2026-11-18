// The collaboration features through Designer's real local server: canvas comments saved as files
// in the project, Claude's comment tools, the shareable preview, pull requests from Azure DevOps
// (through a stand-in for its MCP server), and sharing a review with the preview attached.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/index';
import { shareForReview } from '../src/server/project';
import type { CanvasComment, ServerMessage } from '../src/shared/protocol';

const tmp = (p = 'designer-collab-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
const comment = (over: Partial<CanvasComment> = {}): CanvasComment => ({ id: 'c1', num: 1, x: 10, y: 10, nodeId: 'frame1', dx: 10, dy: 10, author: 'Ada', text: 'Make the title bigger', at: 1000, resolved: false, replies: [], ...over });

let server: Awaited<ReturnType<typeof startServer>>;
let project: string;
let log: string;
const prevAzure = process.env.DESIGNER_AZURE_MCP;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${server.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-designer-token': server.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? String(r.status));
  return data;
}
async function mcp(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'x-designer-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await r.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
}

beforeAll(async () => {
  log = join(tmp(), 'azure.log');
  process.env.DESIGNER_AZURE_MCP = JSON.stringify(['node', join(__dirname, 'fixtures', 'fake-azure-mcp.mjs')]);
  process.env.FAKE_AZURE_LOG = log;
  project = tmp();
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Grace Designer');
  git(project, 'remote', 'add', 'origin', 'https://dev.azure.com/contoso/Shop/_git/web');
  server = await startServer({ port: 0, workspace: tmp() });
  await call('/api/project', { path: project });
});
afterAll(() => {
  server?.close();
  if (prevAzure === undefined) delete process.env.DESIGNER_AZURE_MCP;
  else process.env.DESIGNER_AZURE_MCP = prevAzure;
  delete process.env.FAKE_AZURE_LOG;
});

describe('canvas comments in the project', () => {
  it('saves each comment as its own file and tells every open window', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=${server.token}`, { headers: { origin: server.url } });
    const got = new Promise<ServerMessage>((resolve) => ws.on('message', (d) => { const m = JSON.parse(String(d)) as ServerMessage; if (m.type === 'comments') resolve(m); }));
    await new Promise((r) => ws.on('open', r));
    const r = await call<{ comments: CanvasComment[] }>('/api/comments', { comments: [comment(), comment({ id: 'c2', num: 2, at: 2000, text: 'Use the brand blue' })] });
    expect(r.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(readdirSync(join(project, '.designer', 'comments')).sort()).toEqual(['c1.json', 'c2.json']);
    const m = await got;
    expect(m.type === 'comments' && m.comments.length).toBe(2);
    ws.close();
  });

  it('signs comments with the git user name', async () => {
    expect((await call<{ author: string }>('/api/comments')).author).toBe('Grace Designer');
  });

  it('keeps comments out of canvas.json and adds them back when the canvas loads', async () => {
    await call('/api/canvas', { data: { version: 1, doc: { nodes: {}, root: [], comments: [comment({ text: 'stale copy' })] }, assets: {} } });
    const saved = JSON.parse(readFileSync(join(project, '.designer', 'canvas.json'), 'utf8'));
    expect(saved.doc.comments).toEqual([]);
    const loaded = await call<{ data: { doc: { comments: CanvasComment[] } }; author: string }>('/api/canvas');
    expect(loaded.data.doc.comments.map((c) => c.text)).toEqual(['Make the title bigger', 'Use the brand blue']);
    expect(loaded.author).toBe('Grace Designer');
  });

  it('moves comments out of an older canvas.json the first time it loads', async () => {
    const other = tmp();
    mkdirSync(join(other, '.designer'));
    writeFileSync(join(other, '.designer', 'canvas.json'), JSON.stringify({ version: 1, doc: { nodes: {}, root: [], comments: [comment({ id: 'legacy', text: 'From before' })] } }));
    await call('/api/project', { path: other });
    try {
      const loaded = await call<{ comments: CanvasComment[] }>('/api/canvas');
      expect(loaded.comments.map((c) => c.id)).toEqual(['legacy']);
      expect(existsSync(join(other, '.designer', 'comments', 'legacy.json'))).toBe(true);
    } finally {
      await call('/api/project', { path: project });
    }
  });

  it('lets Claude read, answer and resolve comments', async () => {
    const list = await mcp('get_comments', {});
    expect(list.content[0].text).toContain('#1 (id c1)');
    expect(list.content[0].text).toContain('Make the title bigger');
    const reply = await mcp('reply_to_comment', { id: '1', text: 'Title is 32px now', resolve: true });
    expect(reply.content[0].text).toBe('Replied to comment #1 and resolved it.');
    const file = JSON.parse(readFileSync(join(project, '.designer', 'comments', 'c1.json'), 'utf8')) as CanvasComment;
    expect(file.resolved).toBe(true);
    expect(file.replies).toEqual([expect.objectContaining({ author: 'Claude', text: 'Title is 32px now' })]);
    expect((await mcp('get_comments', {})).content[0].text).not.toContain('Make the title bigger');
    expect((await mcp('reply_to_comment', { id: 'nope', text: 'x' })).isError).toBe(true);
  });
});

describe('shareable preview', () => {
  it('writes the preview into the project with a link to it on the branch', async () => {
    const r = await call<{ files: string[]; link: string; html: string; inProject: boolean }>('/api/preview', {
      frames: [{ id: 'frame1', name: 'Home', w: 200, h: 100, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', pins: [{ id: 'c2', x: 20, y: 10 }] }],
    });
    expect(r.inProject).toBe(true);
    expect(r.files).toEqual(['.designer/preview/README.md', '.designer/preview/home.svg', '.designer/preview/index.html']);
    expect(r.link).toBe('https://dev.azure.com/contoso/Shop/_git/web?path=/.designer/preview/README.md&version=GBmain');
    expect(r.html).toContain('Use the brand blue');
    expect(readFileSync(join(project, '.designer', 'preview', 'README.md'), 'utf8')).toContain('![Home](./home.svg)');
  });
});

describe('pull requests from Azure DevOps', () => {
  it('lists pull requests and their comments, and replies, through the Azure DevOps MCP server', async () => {
    expect(await call('/api/reviews/status')).toMatchObject({ host: 'azure', ready: true, org: 'contoso', project: 'Shop', repo: 'web' });
    const prs = await call<{ id: number; title: string }[]>('/api/reviews');
    expect(prs.map((p) => p.id)).toEqual([42, 43]);
    const threads = await call<{ id: string; comments: { text: string }[] }[]>('/api/reviews/threads?pr=42');
    expect(threads[0].comments[0].text).toBe('Can the gap be 16px?');
    const after = await call<{ id: string; resolved: boolean; comments: { text: string }[] }[]>('/api/reviews/reply', { pr: 42, threadId: '7', text: 'Done in Designer' });
    expect(after.find((t) => t.id === '7')!.comments.at(-1)!.text).toBe('Done in Designer');
    const resolved = await call<{ id: string; resolved: boolean }[]>('/api/reviews/resolve', { pr: 42, threadId: '7', resolved: true });
    expect(resolved.find((t) => t.id === '7')!.resolved).toBe(true);
    await expect(call('/api/reviews/reply', { pr: 42, text: '  ' })).rejects.toThrow('Write a reply first.');
  });
});

describe('Share for review with the preview', () => {
  it('commits the preview and comments, pushes a branch, and links the preview in the pull request', async () => {
    const bare = tmp();
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main');
    // A GitHub-looking remote that really pushes to a local bare repository.
    git(repo, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/grace/shop.git');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/grace/shop.git');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    mkdirSync(join(repo, '.designer', 'preview'), { recursive: true });
    mkdirSync(join(repo, '.designer', 'comments'), { recursive: true });
    writeFileSync(join(repo, '.designer', 'preview', 'README.md'), '# Preview');
    writeFileSync(join(repo, '.designer', 'comments', 'c1.json'), JSON.stringify(comment()));
    writeFileSync(join(repo, 'unsaved.txt'), 'not part of the review');

    const ghCalls: string[][] = [];
    const r = await shareForReview(repo, 'New pricing', { preview: true, gh: async (args) => (ghCalls.push(args), 'https://github.com/grace/shop/pull/7\n') });
    expect(r).toMatchObject({ ok: true, url: 'https://github.com/grace/shop/pull/7', message: 'Opened a pull request with the design preview.' });
    const branch = git(repo, 'branch', '--show-current').trim();
    expect(branch).toMatch(/^design\//);
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['Update design preview and comments', '', '.designer/comments/c1.json', '.designer/preview/README.md']);
    expect(git(bare, 'branch', '--list', branch).trim()).toContain(branch);
    const args = ghCalls[0];
    expect(args.slice(0, 3)).toEqual(['pr', 'create', '--title']);
    expect(args[args.indexOf('--body') + 1]).toContain(`https://github.com/grace/shop/tree/${branch}/.designer/preview`);
    expect(args).not.toContain('--fill');
    // Work the designer has not saved stays out of the review.
    expect(git(repo, 'status', '--porcelain')).toContain('unsaved.txt');
  });
});
