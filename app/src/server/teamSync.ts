import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TeamSyncStatus } from '../shared/protocol.js';
import { WORKSPACE_MANIFEST } from './workspaceTracking.js';
import { friendlyGitError } from './share.js';

const run = promisify(execFile);
const CONFIG = 'designer.autoSyncBranch';
const gitError = (error: unknown) => friendlyGitError(error).replace(/(https?:\/\/)[^\s/@]+@/g, '$1');
const isDesignPath = (path: string) => path === WORKSPACE_MANIFEST || path === '.designer/canvas.json' || /^\.designer\/comments\/[\w-]{1,64}\.json$/.test(path);

async function git(cwd: string, ...args: string[]) {
  return (await run('git', args, {
    cwd, timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout;
}

async function currentBranch(cwd: string) {
  return (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')).trim() || null;
}

async function originURLs(cwd: string) {
  const [fetch, push] = await Promise.all([
    git(cwd, 'remote', 'get-url', 'origin').catch(() => ''),
    git(cwd, 'remote', 'get-url', '--push', '--all', 'origin').catch(() => ''),
  ]);
  return { fetch: fetch.trim(), push: push.trim() };
}

async function remoteBase(cwd: string) {
  const head = await git(cwd, 'ls-remote', '--symref', 'origin', 'HEAD').catch((error) => { throw new Error(gitError(error), { cause: error }); });
  return /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1];
}

async function baseBranch(cwd: string) {
  const local = (await git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').catch(() => '')).trim();
  return local.startsWith('refs/remotes/origin/') ? local.slice('refs/remotes/origin/'.length) : null;
}

export async function teamSyncStatus(cwd: string): Promise<TeamSyncStatus> {
  const [branch, origin, main, value, prefix] = await Promise.all([
    currentBranch(cwd), originURLs(cwd), baseBranch(cwd), git(cwd, 'config', '--local', '--get', CONFIG).catch(() => ''),
    git(cwd, 'rev-parse', '--show-prefix').catch(() => null),
  ]);
  const enabledBranch = value.trim() || null;
  const reason = !origin.fetch ? 'Add an origin remote to this repository to sync with your team.'
    : origin.fetch !== origin.push ? 'Design sync needs one origin with the same fetch and push URL.'
    : prefix !== null && prefix.trim() ? 'Open the repository root as the project to sync with your team.'
    : !branch ? 'Open a branch to sync with your team.'
    : branch === main || (!main && (branch === 'main' || branch === 'master'))
      ? 'Open a working branch to sync design changes. The default branch goes through review.' : null;
  return { branch, enabledBranch, reason };
}

export async function setTeamSync(cwd: string, enabled: boolean, branch: string) {
  const status = await teamSyncStatus(cwd);
  if (status.branch !== branch) throw new Error('The active branch changed. Open the branch again to configure sync.');
  if (enabled) {
    if (status.reason) throw new Error(status.reason);
    const base = await remoteBase(cwd);
    if (!base || base === branch) throw new Error('Choose a working branch in a repository with a default branch.');
    await git(cwd, 'config', '--local', CONFIG, branch);
  } else if (status.enabledBranch) {
    await git(cwd, 'config', '--local', '--unset-all', CONFIG);
  }
  return teamSyncStatus(cwd);
}

export async function fetchTeamBranches(cwd: string) {
  await git(cwd, 'fetch', '--prune', '--no-tags', 'origin').catch((e) => { throw new Error(gitError(e)); });
}

const entries = (text: string) => text.split('\0').filter(Boolean);
const isDesignChange = (entry: string) => {
  const path = entry.slice(3);
  return isDesignPath(path) && !(path === WORKSPACE_MANIFEST && entry.startsWith('??'));
};

/** Check for work without changing the branch or blocking the canvas. */
export async function designSyncNeeded(cwd: string, branch: string) {
  const status = await teamSyncStatus(cwd);
  if (status.branch !== branch || status.enabledBranch !== branch || status.reason) return { needed: false };
  try {
    const ref = `refs/heads/${branch}`;
    const [remote, head, worktree] = await Promise.all([
      git(cwd, 'ls-remote', 'origin', ref),
      git(cwd, 'rev-parse', 'HEAD'),
      git(cwd, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.designer'),
    ]);
    const remoteHead = remote.trim().split('\t')[0];
    return { needed: remoteHead !== head.trim() || entries(worktree).some(isDesignChange) };
  } catch (error) {
    throw new Error(gitError(error), { cause: error });
  }
}

/** Sync only committed design paths, and fast-forward only a clean checkout. */
export async function syncDesignBranch(cwd: string, expectedBranch: string, automatic: boolean) {
  let changed = false;
  try {
    const status = await teamSyncStatus(cwd);
    const branch = status.branch;
    if (!branch || branch !== expectedBranch) throw new Error('The active branch changed. Refresh branch status and retry.');
    if (status.reason) throw new Error(status.reason);
    if (automatic && status.enabledBranch !== branch) throw new Error('Automatic sync is disabled for this branch.');
    // Check the server's default branch directly. Some remotes do not set origin/HEAD locally.
    const base = await remoteBase(cwd);
    if (!base || base === branch) throw new Error('Choose a working branch in a repository with a default branch.');
    await fetchTeamBranches(cwd);

    const upstream = `refs/remotes/origin/${branch}`;
    const remoteHead = (await git(cwd, 'rev-parse', '--verify', '--quiet', upstream).catch(() => '')).trim();
    const reference = remoteHead ? upstream : `refs/remotes/origin/${base}`;
    const [range, worktree] = await Promise.all([
      git(cwd, 'rev-list', '--left-right', '--count', `HEAD...${reference}`),
      git(cwd, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'),
    ]);
    const [ahead, behind] = range.trim().split(/\s+/).map(Number);
    const paths = entries(worktree).map((entry) => entry.slice(3));
    const design = entries(worktree).filter(isDesignChange).map((entry) => entry.slice(3));

    if (ahead || design.length || !remoteHead) {
      const commits = entries(await git(cwd, 'log', '--diff-merges=first-parent', '--no-renames', '--format=', '--name-only', '-z', `${reference}..HEAD`));
      if (commits.some((path) => !isDesignPath(path))) {
        throw new Error('This branch has local code commits. Send them through your normal Git review workflow before syncing design.');
      }
    }
    if (remoteHead && behind && (ahead || design.length)) {
      throw new Error('Both copies have design or branch changes. Review and merge them in Git, then sync again.');
    }

    async function checkBranch() {
      if (await currentBranch(cwd) !== branch) throw new Error('The active branch changed while syncing.');
    }
    await checkBranch();
    if (remoteHead && behind) {
      if (paths.length) throw new Error('Save or set aside local changes before receiving the team’s versions.');
      await git(cwd, 'merge', '--ff-only', '--no-overwrite-ignore', remoteHead);
      changed = true;
    } else if (design.length) {
      // The --only commit leaves unrelated entries in the staging area.
      await git(cwd, 'add', '-A', '--', ...design);
      await checkBranch();
      await git(cwd, 'commit', '--only', '-m', 'Sync Designer canvas', '--', ...design);
    }
    if (!changed && (ahead || design.length || !remoteHead)) {
      await checkBranch();
      const ref = `refs/heads/${branch}`;
      const head = (await git(cwd, 'rev-parse', ref)).trim();
      const outgoing = entries(await git(cwd, 'log', '--diff-merges=first-parent', '--no-renames', '--format=', '--name-only', '-z', `${reference}..${head}`));
      if (outgoing.some((path) => !isDesignPath(path))) throw new Error('The local commits include changes outside the design. Review the branch in Git.');
      // Push the inspected object so that a concurrent local commit cannot be included.
      await git(cwd, '-c', 'push.followTags=false', 'push', 'origin', `${head}:${ref}`);
      if (await currentBranch(cwd) === branch) await git(cwd, 'branch', '--set-upstream-to', `origin/${branch}`, branch);
      return { ok: true, changed, message: `Sent the design on ${branch}.` };
    }
    return { ok: true, changed, message: changed ? `Received the team’s changes on ${branch}.` : 'Design is up to date.' };
  } catch (error) {
    return { ok: false, changed, message: gitError(error) };
  }
}
