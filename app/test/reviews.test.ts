import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AzureReviews, azureMcpCommand, GitHubReviews, hostOf, reviewProvider } from '../src/server/reviews';
import { StdioMcpClient } from '../src/server/mcpClient';

const fakeAzure = join(__dirname, 'fixtures', 'fake-azure-mcp.mjs');
const REMOTE = 'https://contoso@dev.azure.com/contoso/Shop/_git/web';

describe('where pull requests come from', () => {
  it('picks the host from the git remote', () => {
    expect(hostOf(REMOTE)).toBe('azure');
    expect(hostOf('git@ssh.dev.azure.com:v3/contoso/Shop/web')).toBe('azure');
    expect(hostOf('git@github.com:grace/designer.git')).toBe('github');
    expect(hostOf('https://gitlab.com/a/b')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    expect(reviewProvider('/x', REMOTE)).toBeInstanceOf(AzureReviews);
    expect(reviewProvider('/x', 'https://github.com/a/b')).toBeInstanceOf(GitHubReviews);
    expect(reviewProvider('/x', undefined)).toBeNull();
  });
  it("runs Microsoft's Azure DevOps MCP server for the organization", () => {
    expect(azureMcpCommand('contoso', {})).toEqual({ command: 'npx', args: ['-y', '@azure-devops/mcp', 'contoso'] });
    expect(azureMcpCommand('contoso', { DESIGNER_AZURE_MCP: '["node","x.mjs"]' })).toEqual({ command: 'node', args: ['x.mjs', 'contoso'] });
  });
});

describe('Azure DevOps through its MCP server', () => {
  let az: AzureReviews;
  let log: string;
  beforeEach(() => {
    log = join(realpathSync(mkdtempSync(join(tmpdir(), 'designer-az-'))), 'calls.log');
    az = new AzureReviews(REMOTE, new StdioMcpClient('node', [fakeAzure, 'contoso'], { env: { ...process.env, FAKE_AZURE_LOG: log }, timeoutMs: 10000 }));
  });
  afterEach(() => az.close());
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> });

  it('reports ready, with the organization, project and repository', async () => {
    expect(await az.status()).toEqual({ host: 'azure', ready: true, org: 'contoso', project: 'Shop', repo: 'web' });
    expect(az.mcpServerConfig()).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@azure-devops/mcp', 'contoso'] });
  });

  it('lists active pull requests for the repository', async () => {
    const prs = await az.list();
    expect(prs[0]).toEqual({
      id: 42,
      title: 'Denser pricing cards',
      author: 'Ada Lovelace',
      branch: 'design/pricing',
      target: 'main',
      status: 'active',
      draft: false,
      updatedAt: '2026-11-18T10:00:00Z',
      url: 'https://dev.azure.com/contoso/Shop/_git/web/pullrequest/42',
    });
    expect(prs[1].draft).toBe(true);
    // The repository name is turned into its id first, then used for the listing.
    expect(calls().map((c) => c.name)).toEqual(['repo_get_repo_by_name_or_id', 'repo_list_pull_requests_by_repo_or_project']);
    expect(calls()[1].args).toMatchObject({ project: 'Shop', repositoryId: 'repo-guid-1' });
  });

  it('reads comment threads, leaving out system messages', async () => {
    const t = await az.threads(42);
    expect(t).toEqual([
      { id: '7', file: 'src/Pricing.tsx', line: 12, resolved: false, comments: [{ id: '1', author: 'Ada Lovelace', text: 'Can the gap be 16px?', at: '2026-11-18T10:05:00Z' }] },
      { id: '9', file: undefined, line: undefined, resolved: true, comments: [{ id: '1', author: 'Grace Hopper', text: 'Looks good overall', at: undefined }] },
    ]);
  });

  it('replies in a thread, starts a new one, and resolves', async () => {
    await az.reply(42, '7', 'Done, 16px now');
    await az.reply(42, undefined, 'Preview is in .designer/preview');
    await az.resolve(42, '7', true);
    const t = await az.threads(42);
    expect(t.find((x) => x.id === '7')).toMatchObject({ resolved: true });
    expect(t.find((x) => x.id === '7')!.comments.map((c) => c.text)).toContain('Done, 16px now');
    expect(t.some((x) => x.comments[0].text === 'Preview is in .designer/preview')).toBe(true);
    const names = calls().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['repo_reply_to_comment', 'repo_create_pull_request_thread', 'repo_resolve_comment']));
    expect(calls().find((c) => c.name === 'repo_reply_to_comment')!.args).toMatchObject({ pullRequestId: 42, threadId: 7, content: 'Done, 16px now' });
  });

  it('says what went wrong when the server cannot start', async () => {
    const broken = new AzureReviews(REMOTE, new StdioMcpClient('definitely-not-a-command-xyz', [], { timeoutMs: 3000 }));
    const s = await broken.status();
    expect(s.ready).toBe(false);
    expect(s.problem).toMatch(/Could not start the Azure DevOps MCP server/);
    broken.close();
  });
});

describe('GitHub through the gh CLI', () => {
  const fakeGh = (answers: Record<string, string>, seen: string[][] = []) => async (args: string[]) => {
    seen.push(args);
    const key = Object.keys(answers).find((k) => args.join(' ').includes(k));
    if (key === undefined) throw Object.assign(new Error('unexpected'), { code: 1 });
    return answers[key];
  };

  it('lists open pull requests', async () => {
    const gh = new GitHubReviews('/repo', fakeGh({ 'pr list': JSON.stringify([{ number: 5, title: 'Comments', author: { login: 'grace' }, headRefName: 'feat', baseRefName: 'main', state: 'OPEN', url: 'https://github.com/a/b/pull/5', isDraft: false, updatedAt: '2026-11-18' }]) }));
    expect(await gh.list()).toEqual([{ id: 5, title: 'Comments', author: 'grace', branch: 'feat', target: 'main', status: 'open', url: 'https://github.com/a/b/pull/5', draft: false, updatedAt: '2026-11-18' }]);
  });

  it('groups review comments into threads and replies in the right place', async () => {
    const seen: string[][] = [];
    const gh = new GitHubReviews(
      '/repo',
      fakeGh(
        {
          'issues/5/comments': JSON.stringify([{ id: 1, user: { login: 'bo' }, body: 'Nice', created_at: 't1' }]),
          'pulls/5/comments/10/replies': '{}',
          'pulls/5/comments': JSON.stringify([
            { id: 10, user: { login: 'ada' }, body: 'Use the token', path: 'src/a.css', line: 3 },
            { id: 11, in_reply_to_id: 10, user: { login: 'grace' }, body: 'Will do', path: 'src/a.css', line: 3 },
          ]),
          'pr comment': '',
        },
        seen,
      ),
    );
    const t = await gh.threads(5);
    expect(t.map((x) => [x.id, x.file, x.comments.length])).toEqual([['issue:1', undefined, 1], ['review:10', 'src/a.css', 2]]);
    await gh.reply(5, 'review:10', 'Done');
    await gh.reply(5, undefined, 'General');
    expect(seen.find((a) => a.includes('-X'))).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/5/comments/10/replies', '-f', 'body=Done']);
    expect(seen.at(-1)).toEqual(['pr', 'comment', '5', '--body', 'General']);
  });

  it('asks the user to sign in when gh is not signed in', async () => {
    const gh = new GitHubReviews('/repo', fakeGh({}));
    expect(await gh.status()).toMatchObject({ host: 'github', ready: false, problem: expect.stringMatching(/gh auth login/) });
  });
});
