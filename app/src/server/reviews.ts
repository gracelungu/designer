// Pull requests and their comments, for the Reviews panel. The project's git remote decides where
// they come from:
// - Azure DevOps: Microsoft's Azure DevOps MCP server (@azure-devops/mcp), run locally over stdio.
//   It signs in with the user's own Microsoft account, so Designer never holds a token.
// - GitHub: the GitHub CLI (gh), with the user's own `gh auth login`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequestSummary, ReviewStatus, ReviewThread } from '../shared/protocol.js';
import { StdioMcpClient } from './mcpClient.js';
import { parseAzureRemote } from './preview.js';

const run = promisify(execFile);

export interface ReviewProvider {
  status(): Promise<ReviewStatus>;
  list(): Promise<PullRequestSummary[]>;
  threads(pr: number): Promise<ReviewThread[]>;
  /** Replies in a thread, or starts a new general thread when threadId is empty. */
  reply(pr: number, threadId: string | undefined, text: string): Promise<void>;
  resolve?(pr: number, threadId: string, resolved: boolean): Promise<void>;
  close(): void;
}

/** The command that starts the Azure DevOps MCP server. DESIGNER_AZURE_MCP overrides it (a JSON array). */
export function azureMcpCommand(org: string, env = process.env): { command: string; args: string[] } {
  if (env.DESIGNER_AZURE_MCP) {
    const [command, ...args] = JSON.parse(env.DESIGNER_AZURE_MCP) as string[];
    return { command, args: [...args, org] };
  }
  return { command: 'npx', args: ['-y', '@azure-devops/mcp', org] };
}

export function hostOf(remote: string | undefined): 'github' | 'azure' | null {
  if (!remote) return null;
  if (parseAzureRemote(remote)) return 'azure';
  if (/github\.com[:/]/.test(remote)) return 'github';
  return null;
}

export function reviewProvider(cwd: string, remote: string | undefined): ReviewProvider | null {
  const host = hostOf(remote);
  if (host === 'azure') return new AzureReviews(remote!);
  if (host === 'github') return new GitHubReviews(cwd);
  return null;
}

// ---------------- Azure DevOps (MCP) ----------------

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const branchName = (ref: unknown) => str(ref).replace(/^refs\/heads\//, '');
/** MCP tools return either the array or an object wrapping it ({ value: [...] }, { pullRequests: [...] }). */
function asList(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === 'object') for (const k of ['value', 'pullRequests', 'threads', 'comments', 'items']) if (Array.isArray((v as Record<string, unknown>)[k])) return (v as Record<string, unknown[]>)[k] as Record<string, unknown>[];
  return [];
}

export class AzureReviews implements ReviewProvider {
  readonly org: string;
  readonly project: string;
  readonly repo: string;
  private client: StdioMcpClient;
  private repoId?: string;

  constructor(remote: string, client?: StdioMcpClient) {
    const az = parseAzureRemote(remote)!;
    this.org = az.org;
    this.project = az.project;
    this.repo = az.repo;
    const cmd = azureMcpCommand(this.org);
    this.client = client ?? new StdioMcpClient(cmd.command, cmd.args, { timeoutMs: 120000 });
  }

  /** The MCP server config Claude Code gets too, so Claude can read and answer PR comments in chat. */
  mcpServerConfig() {
    const cmd = azureMcpCommand(this.org);
    return { type: 'stdio', command: cmd.command, args: cmd.args };
  }

  private tool(kind: 'list' | 'threads' | 'reply' | 'create' | 'repo' | 'resolve') {
    const c = this.client;
    const t = {
      list: () => c.find(/^repo_list_pull_requests_by_repo_or_project$/, /^repo_list_pull_requests_by_repo$/, /list_pull_requests/),
      threads: () => c.find(/^repo_list_pull_request_threads$/, /pull_request_threads/),
      reply: () => c.find(/^repo_reply_to_comment$/, /reply.*comment/),
      create: () => c.find(/^repo_create_pull_request_thread$/, /create_pull_request_thread/),
      repo: () => c.find(/^repo_get_repo_by_name_or_id$/, /get_repo_by_name/),
      resolve: () => c.find(/^repo_resolve_comment$/, /^repo_update_pull_request_thread$/, /resolve_comment/),
    }[kind]();
    if (!t) throw new Error(`The Azure DevOps MCP server has no tool to ${kind === 'list' ? 'list pull requests' : kind === 'threads' ? 'read comments' : kind === 'repo' ? 'find the repository' : kind === 'resolve' ? 'resolve comments' : 'reply'}. Update it with: npx -y @azure-devops/mcp@latest`);
    return t;
  }

  private async repositoryId() {
    if (this.repoId) return this.repoId;
    await this.client.start();
    let id = this.repo;
    try {
      const r = (await this.client.call(this.tool('repo'), { project: this.project, repositoryNameOrId: this.repo })) as Record<string, unknown>;
      if (r && typeof r === 'object' && typeof r.id === 'string') id = r.id;
    } catch {
      // Older servers take the name directly.
    }
    this.repoId = id;
    return id;
  }

  async status(): Promise<ReviewStatus> {
    const base = { host: 'azure' as const, org: this.org, project: this.project, repo: this.repo };
    try {
      await this.client.start();
      this.tool('list');
      return { ...base, ready: true };
    } catch (e) {
      return { ...base, ready: false, problem: `Could not start the Azure DevOps MCP server (${(e as Error).message}). It needs Node 20+, and signs in with your Microsoft account the first time.` };
    }
  }

  async list(): Promise<PullRequestSummary[]> {
    const repositoryId = await this.repositoryId();
    const r = await this.client.call(this.tool('list'), { project: this.project, repositoryId, status: 'Active', top: 50 });
    return asList(r).map((p) => {
      const id = Number(p.pullRequestId ?? p.id);
      const by = (p.createdBy ?? {}) as Record<string, unknown>;
      return {
        id,
        title: str(p.title),
        author: str(by.displayName ?? by.uniqueName ?? p.author),
        branch: branchName(p.sourceRefName),
        target: branchName(p.targetRefName),
        status: str(p.status ?? 'active').toLowerCase(),
        draft: !!p.isDraft,
        updatedAt: str(p.creationDate) || undefined,
        url: `https://dev.azure.com/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(this.repo)}/pullrequest/${id}`,
      };
    });
  }

  async threads(pr: number): Promise<ReviewThread[]> {
    const repositoryId = await this.repositoryId();
    const r = await this.client.call(this.tool('threads'), { project: this.project, repositoryId, pullRequestId: pr, fullResponse: true });
    return asList(r)
      .map((t) => {
        const ctx = (t.threadContext ?? {}) as Record<string, unknown>;
        const line = ((ctx.rightFileStart ?? ctx.leftFileStart) as { line?: number } | undefined)?.line;
        const comments = asList(t.comments ?? [])
          .filter((c) => str(c.commentType).toLowerCase() !== 'system' && !c.isDeleted && str(c.content).trim())
          .map((c) => ({ id: str(c.id), author: str(((c.author ?? {}) as Record<string, unknown>).displayName ?? c.author), text: str(c.content), at: str(c.publishedDate) || undefined }));
        const status = str(t.status).toLowerCase();
        return { id: str(t.id), file: str(ctx.filePath).replace(/^\//, '') || undefined, line, resolved: ['fixed', 'closed', 'wontfix', 'bydesign'].includes(status), comments };
      })
      .filter((t) => t.comments.length > 0);
  }

  async reply(pr: number, threadId: string | undefined, text: string) {
    const repositoryId = await this.repositoryId();
    if (threadId) await this.client.call(this.tool('reply'), { project: this.project, repositoryId, pullRequestId: pr, threadId: Number(threadId), content: text });
    else await this.client.call(this.tool('create'), { project: this.project, repositoryId, pullRequestId: pr, content: text });
  }

  async resolve(pr: number, threadId: string, resolved: boolean) {
    const repositoryId = await this.repositoryId();
    await this.client.call(this.tool('resolve'), { project: this.project, repositoryId, pullRequestId: pr, threadId: Number(threadId), status: resolved ? 'Fixed' : 'Active' });
  }

  close() {
    this.client.stop();
  }
}

// ---------------- GitHub (gh CLI) ----------------

type Exec = (args: string[], cwd: string) => Promise<string>;
const ghExec: Exec = async (args, cwd) => (await run('gh', args, { cwd, timeout: 60000, maxBuffer: 20 * 1024 * 1024 })).stdout;

export class GitHubReviews implements ReviewProvider {
  constructor(
    readonly cwd: string,
    private readonly gh: Exec = ghExec,
  ) {}

  async status(): Promise<ReviewStatus> {
    try {
      await this.gh(['auth', 'status'], this.cwd);
      return { host: 'github', ready: true };
    } catch (e) {
      const msg = (e as { code?: string }).code === 'ENOENT' ? 'Install the GitHub CLI (gh) to see pull requests here.' : 'Sign in to GitHub with `gh auth login` to see pull requests here.';
      return { host: 'github', ready: false, problem: msg };
    }
  }

  async list(): Promise<PullRequestSummary[]> {
    const out = await this.gh(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,author,headRefName,baseRefName,state,url,isDraft,updatedAt'], this.cwd);
    return (JSON.parse(out || '[]') as Record<string, unknown>[]).map((p) => ({
      id: Number(p.number),
      title: str(p.title),
      author: str((p.author as { login?: string } | undefined)?.login),
      branch: str(p.headRefName),
      target: str(p.baseRefName),
      status: str(p.state).toLowerCase(),
      url: str(p.url),
      draft: !!p.isDraft,
      updatedAt: str(p.updatedAt) || undefined,
    }));
  }

  async threads(pr: number): Promise<ReviewThread[]> {
    const general = JSON.parse((await this.gh(['api', `repos/{owner}/{repo}/issues/${pr}/comments`, '--paginate'], this.cwd)) || '[]') as Record<string, unknown>[];
    const code = JSON.parse((await this.gh(['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '--paginate'], this.cwd)) || '[]') as Record<string, unknown>[];
    const who = (c: Record<string, unknown>) => str((c.user as { login?: string } | undefined)?.login);
    const out: ReviewThread[] = general.map((c) => ({ id: `issue:${str(c.id)}`, resolved: false, comments: [{ id: str(c.id), author: who(c), text: str(c.body), at: str(c.created_at) || undefined }] }));
    const roots = new Map<string, ReviewThread>();
    for (const c of code) {
      const rootId = str(c.in_reply_to_id || c.id);
      let t = roots.get(rootId);
      if (!t) {
        t = { id: `review:${rootId}`, file: str(c.path) || undefined, line: (c.line ?? c.original_line) as number | undefined, resolved: false, comments: [] };
        roots.set(rootId, t);
        out.push(t);
      }
      t.comments.push({ id: str(c.id), author: who(c), text: str(c.body), at: str(c.created_at) || undefined });
    }
    return out;
  }

  async reply(pr: number, threadId: string | undefined, text: string) {
    if (threadId?.startsWith('review:')) {
      await this.gh(['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${pr}/comments/${threadId.slice(7)}/replies`, '-f', `body=${text}`], this.cwd);
      return;
    }
    await this.gh(['pr', 'comment', String(pr), '--body', text], this.cwd);
  }

  close() {}
}
