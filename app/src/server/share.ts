// "Send for review": one click that saves the designer's changes as a version on a branch of its
// own, uploads the before/after screenshots, pushes, and opens a pull request that shows them.
// The designer never sees a git command; every failure comes back in plain words.
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ShareStep, VisualReview } from '../shared/protocol.js';
import { gitStatus } from './project.js';
import { excludeReviews, summarize } from './visual.js';
import { previewLink } from './preview.js';

const run = promisify(execFile);

export const SCREENSHOTS_BRANCH = 'designer-screenshots';

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const { stdout } = await run('git', args, { cwd, timeout: 120000, maxBuffer: 20 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return stdout;
}

/** owner/repo of a GitHub remote, in any of its URL forms. */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url?.trim() ?? '');
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

/** The web address of a remote (GitHub, GitLab, Azure DevOps or any https remote), without credentials. */
export function webUrl(remote: string) {
  return remote
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
    .replace(/^https:\/\/[^@/]+@/, 'https://')
    .replace(/\.git$/, '');
}

/** Turns git's and gh's messages into something a designer can act on. */
export function friendlyGitError(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  const text = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message ?? ''}`;
  if (/Please tell me who you are|empty ident|user\.email/i.test(text)) return 'Git does not know your name yet. Ask Claude in the chat to "set up my git name and email", then try again.';
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)|403|HTTP Basic: Access denied|terminal prompts disabled/i.test(text)) return 'The repository did not accept your sign-in. Sign in to GitHub on this computer (for example with GitHub Desktop or `gh auth login`), then try again.';
  if (/Could not resolve host|unable to access|Network is unreachable|timed out/i.test(text)) return 'Could not reach the repository. Check your internet connection and try again.';
  if (/CONFLICT|could not apply|needs merge|unmerged/i.test(text)) return 'Your changes and the team’s changes touch the same lines. Ask Claude in the chat to "get latest and resolve the conflicts", then send again.';
  if (/protected branch|GH006/i.test(text)) return 'That branch is protected, so changes have to go through a pull request.';
  return (err.stderr || err.message || String(e)).trim().split('\n').slice(-3).join('\n');
}

/** A branch name from the title: "design/denser-pricing-cards-x3k9". */
export function branchName(title: string, rand = Math.random().toString(36).slice(2, 6)) {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `design/${s || 'update'}-${rand}`;
}

export async function defaultBranch(cwd: string) {
  const head = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head) return head.replace(/^origin\//, '');
  const ls = await git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '');
  const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(ls);
  if (m) return m[1];
  for (const b of ['main', 'master']) if ((await git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`]).catch(() => '')).trim()) return b;
  return 'main';
}

export interface ShotFile {
  /** Path inside the screenshots branch. */
  path: string;
  /** File on disk. */
  abs: string;
}

/**
 * Puts screenshots on their own branch of the repository (designer-screenshots), so the pull
 * request can show them without adding image files to the change itself. Builds the commit with a
 * private index, so the designer's working folder and branch are never touched. Returns the commit.
 */
export async function uploadScreenshots(cwd: string, files: ShotFile[]): Promise<string> {
  const ref = 'refs/designer/screenshots';
  await git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${SCREENSHOTS_BRANCH}:${ref}`]).catch(() => undefined);
  const parent = (await git(cwd, ['rev-parse', '--verify', '-q', ref]).catch(() => '')).trim();
  const index = join(tmpdir(), `designer-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (parent) await git(cwd, ['read-tree', parent], env);
    else await git(cwd, ['read-tree', '--empty'], env);
    for (const f of files) {
      const sha = (await git(cwd, ['hash-object', '-w', f.abs])).trim();
      await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${sha},${f.path}`], env);
    }
    const tree = (await git(cwd, ['write-tree'], env)).trim();
    const commit = (await git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Designer review screenshots'])).trim();
    await git(cwd, ['update-ref', ref, commit]);
    await git(cwd, ['push', '--quiet', 'origin', `${commit}:refs/heads/${SCREENSHOTS_BRANCH}`]);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

export interface PrBodyInput {
  description?: string;
  reviews: VisualReview[];
  /** review id + file name -> image URL. */
  image: (reviewId: string, file: string) => string | undefined;
  files: string[];
}

export function prBody({ description, reviews, image, files }: PrBodyInput) {
  const parts: string[] = [];
  if (description?.trim()) parts.push(description.trim());
  const visual = reviews.filter((r) => r.shots.length);
  if (visual.length) {
    parts.push('## What changed visually');
    for (const r of visual) {
      parts.push(`### ${r.title}\n_${summarize(r)}_`);
      const rows: string[] = [];
      const same: string[] = [];
      for (const s of r.shots) {
        const b = s.before && image(r.id, s.before);
        const a = s.after && image(r.id, s.after);
        if (!a) {
          if (s.error) same.push(`${s.label} (no screenshot: ${s.error.split('\n')[0]})`);
          continue;
        }
        if (b && !s.changed) {
          same.push(s.label);
          continue;
        }
        const d = s.diff && image(r.id, s.diff);
        const pct = s.changed !== undefined ? ` · ${formatPct(s.changed)} of pixels changed${s.sizeChanged ? ', size changed' : ''}` : ' · new';
        rows.push(`| **${s.label}**${pct}${d ? ` · [highlight](${d})` : ''} | |\n| ${b ? `<img src="${b}" width="360" alt="${s.label} before">` : '_none_'} | <img src="${a}" width="360" alt="${s.label} after"> |`);
      }
      if (rows.length) parts.push(`| Before | After |\n| --- | --- |\n${rows.join('\n')}`);
      if (same.length) parts.push(`No visible change: ${same.join(', ')}`);
    }
  }
  if (files.length) parts.push(`## Files\n${files.slice(0, 40).map((f) => `- \`${f}\``).join('\n')}${files.length > 40 ? `\n- …and ${files.length - 40} more` : ''}`);
  parts.push('---\n_Sent from Designer_');
  return parts.join('\n\n');
}

function formatPct(r: number) {
  const p = r * 100;
  return `${p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** The page that opens a pull request with title and description filled in (when gh can't). */
export function compareUrl(remote: string, base: string, head: string, title: string, body: string) {
  const web = webUrl(remote);
  const max = 6000;
  const b = body.length > max ? `${body.slice(0, max)}\n\n…` : body;
  if (/dev\.azure\.com|visualstudio\.com/.test(web)) return `${web}/pullrequestcreate?sourceRef=${encodeURIComponent(head)}&targetRef=${encodeURIComponent(base)}`;
  if (/gitlab/.test(web)) return `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(head)}&merge_request[target_branch]=${encodeURIComponent(base)}&merge_request[title]=${encodeURIComponent(title)}`;
  return `${web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
}

export interface SendOptions {
  title: string;
  description?: string;
  reviews: VisualReview[];
  /** Folder of a review's images. */
  reviewDir: (id: string) => string;
  onStep?: (step: ShareStep, state: 'running' | 'done' | 'skipped' | 'error', detail?: string) => void;
  /** The gh CLI to open the pull request with (default: `gh` on PATH). */
  gh?: string;
  /** Link the design preview (.designer/preview, saved with the change) from the pull request. */
  preview?: boolean;
}

export interface SendResult {
  ok: boolean;
  message: string;
  url?: string;
  branch?: string;
  /** True when the link opens a prefilled page and the designer clicks Create there. */
  needsConfirm?: boolean;
}

export async function sendForReview(cwd: string, opts: SendOptions): Promise<SendResult> {
  const step = opts.onStep ?? (() => undefined);
  const title = opts.title.trim() || opts.reviews[0]?.title || 'Design update';
  const st = await gitStatus(cwd);
  if (!st.isRepo) return { ok: false, message: 'This folder is not a git repository yet, so there is nowhere to send it.' };
  const remote = (await git(cwd, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
  if (!remote) return { ok: false, message: 'This project has no remote to share to. Ask Claude in the chat to publish it to GitHub first.' };
  await excludeReviews(cwd);
  const base = await defaultBranch(cwd);
  const fresh = await gitStatus(cwd);
  const unsaved = fresh.changed.length;
  const aheadOfBase = Number((await git(cwd, ['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`]).catch(() => '0')).trim()) || 0;
  if (!unsaved && !aheadOfBase) return { ok: false, message: 'Nothing new to send: everything here is already on the team’s copy.' };

  // 1. A branch of its own, so nothing lands on the main design directly.
  let branch = fresh.branch && fresh.branch !== '(detached)' ? fresh.branch : undefined;
  step('branch', 'running');
  try {
    if (!branch || branch === base) {
      branch = branchName(title);
      await git(cwd, ['switch', '-c', branch]);
      step('branch', 'done', branch);
    } else step('branch', 'skipped', branch);
  } catch (e) {
    step('branch', 'error');
    return { ok: false, message: friendlyGitError(e) };
  }

  // 2. Save everything as a version.
  step('save', 'running');
  try {
    if (unsaved) {
      await git(cwd, ['add', '-A']);
      await git(cwd, ['commit', '-q', '-m', title, ...(opts.description?.trim() ? ['-m', opts.description.trim()] : [])]);
      step('save', 'done');
    } else step('save', 'skipped');
  } catch (e) {
    step('save', 'error');
    return { ok: false, message: friendlyGitError(e), branch };
  }
  const files = (await git(cwd, ['diff', '--name-only', `refs/remotes/origin/${base}...HEAD`]).catch(() => git(cwd, ['show', '--name-only', '--format=', 'HEAD']).catch(() => '')))
    .split('\n')
    .filter(Boolean);

  // 3. Screenshots on their own branch, linked from the pull request.
  const gh = parseGitHubRemote(remote);
  const images = new Map<string, string>();
  const shotFiles: ShotFile[] = [];
  for (const r of opts.reviews)
    for (const s of r.shots)
      for (const f of [s.before, s.after, s.diff]) if (f) shotFiles.push({ path: `reviews/${branch}/${r.id}/${f}`, abs: join(opts.reviewDir(r.id), f) });
  let screenshotsNote = '';
  if (!shotFiles.length) step('screenshots', 'skipped', 'No screenshots to add');
  else if (!gh) {
    step('screenshots', 'skipped', 'Screenshots can be attached on GitHub only');
    screenshotsNote = ' Screenshots were not attached: that only works with GitHub for now.';
  } else {
    step('screenshots', 'running', `${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}`);
    try {
      const commit = await uploadScreenshots(cwd, shotFiles);
      for (const f of shotFiles) images.set(f.path, `https://github.com/${gh.owner}/${gh.repo}/blob/${commit}/${f.path.split('/').map(encodeURIComponent).join('/')}?raw=true`);
      step('screenshots', 'done');
    } catch (e) {
      step('screenshots', 'error', friendlyGitError(e));
      screenshotsNote = ' The screenshots could not be uploaded, so the review has none.';
    }
  }

  // 4. Push the branch (catching up first if a teammate pushed to it).
  step('push', 'running');
  try {
    try {
      await git(cwd, ['push', '-u', 'origin', branch]);
    } catch (e) {
      if (!/rejected|non-fast-forward|fetch first/i.test(friendlyGitError(e) + String((e as { stderr?: string }).stderr))) throw e;
      await git(cwd, ['pull', '--rebase', 'origin', branch]);
      await git(cwd, ['push', '-u', 'origin', branch]);
    }
    step('push', 'done');
  } catch (e) {
    step('push', 'error');
    return { ok: false, message: friendlyGitError(e), branch };
  }

  // 5. The pull request.
  step('pr', 'running');
  const link = opts.preview ? previewLink(remote, branch) : undefined;
  const description = link ? `**Design preview:** ${link}\n\nFrames, comments and specs from Designer. Open \`.designer/preview/index.html\` for the interactive version.${opts.description?.trim() ? `\n\n${opts.description.trim()}` : ''}` : opts.description;
  const body = prBody({ description, reviews: opts.reviews, image: (id, f) => images.get(`reviews/${branch}/${id}/${f}`), files });
  const bodyFile = join(tmpdir(), `designer-pr-${process.pid}-${Date.now()}.md`);
  await writeFile(bodyFile, body);
  try {
    const ghBin = opts.gh ?? 'gh';
    try {
      const { stdout } = await run(ghBin, ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd, timeout: 60000 });
      const url = stdout.trim().split('\n').pop();
      step('pr', 'done', url);
      return { ok: true, message: `Sent for review.${screenshotsNote}`, url, branch };
    } catch (e) {
      const err = e as { stderr?: string; code?: string };
      const existing = /https:\/\/\S+\/pull\/\d+/.exec(err.stderr ?? '');
      if (existing) {
        // Already open: add the new screenshots to the conversation instead.
        await run(ghBin, ['pr', 'comment', existing[0], '--body-file', bodyFile], { cwd, timeout: 60000 }).catch(() => undefined);
        step('pr', 'done', existing[0]);
        return { ok: true, message: `Updated the open review with your new changes.${screenshotsNote}`, url: existing[0], branch };
      }
      const url = compareUrl(remote, base, branch, title, body);
      step('pr', 'done', 'Finish in the browser');
      return { ok: true, needsConfirm: true, message: `Your changes are on the team’s copy. Open the link and click Create to start the review; the description and screenshots are filled in.${screenshotsNote}`, url, branch };
    }
  } finally {
    await rm(bodyFile, { force: true });
  }
}

/** For tests and the UI: read a review's image bytes. */
export async function readShot(dir: string, file: string) {
  return readFile(join(dir, file));
}
