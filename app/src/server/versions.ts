// Version history in designer words, the way Figma shows it, backed by git in the project folder:
//   version            = a commit            named version = a tag under version/
//   variation          = a branch            restore       = a new version with the old content
//   sync with the team = pull, then push
// Nothing here ever throws work away: switching or restoring with unsaved changes saves them first.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VersionEntry, VersionHistory, Variation } from '../shared/protocol.js';
import { gitStatus } from './project.js';
import { defaultBranch, friendlyGitError } from './share.js';
import { excludeReviews } from './visual.js';

const run = promisify(execFile);
const US = '\x1f';
const RS = '\x1e';

async function git(cwd: string, args: string[]) {
  const { stdout } = await run('git', args, { cwd, timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** "Denser pricing cards" -> "denser-pricing-cards". */
export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** A variation's name as git allows it: "Dark mode" -> "design/dark-mode"; names with a slash stay as they are. */
export function variationRef(name: string) {
  const n = name.trim();
  if (/^[\w.-]+(\/[\w.-]+)+$/.test(n)) return n;
  const s = slugify(n);
  if (!s) throw new Error('Give the variation a name.');
  return `design/${s}`;
}

/** Parses `git log --format=%H␟%h␟%s␟%b␟%an␟%at␞ --name-only`. */
export function parseLog(out: string): Omit<VersionEntry, 'local' | 'name'>[] {
  return out
    .split(RS)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.includes(US))
    .map((chunk) => {
      const [id, short, title, body, author, date, rest = ''] = chunk.split(US);
      return { id, short, title, description: body.trim() || undefined, author, date: Number(date) * 1000, files: rest.split('\n').filter((l) => l.trim()).length };
    });
}

async function upstreamRange(cwd: string, base: string) {
  const up = (await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
  if (up) return `${up}..HEAD`;
  const hasBase = (await git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]).catch(() => '')).trim();
  return hasBase ? `refs/remotes/origin/${base}..HEAD` : 'HEAD';
}

export async function history(cwd: string, limit = 60): Promise<VersionHistory> {
  const st = await gitStatus(cwd);
  if (!st.isRepo) throw new Error('This folder has no version history yet. Ask Claude in the chat to "start version history here".');
  const base = st.remote ? await defaultBranch(cwd) : (st.branch ?? 'main');
  const hasCommits = !!(await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  const log = hasCommits ? await git(cwd, ['log', `-n${limit}`, `--format=${RS}%H${US}%h${US}%s${US}%b${US}%an${US}%at${US}`, '--name-only']) : '';
  const local = new Set(hasCommits && st.remote ? (await git(cwd, ['rev-list', await upstreamRange(cwd, base)]).catch(() => '')).split('\n').filter(Boolean) : []);
  const tags = await git(cwd, ['for-each-ref', 'refs/tags/version/', `--format=%(objectname)${US}%(*objectname)${US}%(contents:subject)`]).catch(() => '');
  const names = new Map<string, string>();
  for (const line of tags.split('\n').filter(Boolean)) {
    const [obj, deref, subject] = line.split(US);
    names.set(deref || obj, subject);
  }
  const versions: VersionEntry[] = parseLog(log).map((v) => ({ ...v, local: !st.remote || local.has(v.id), name: names.get(v.id) }));
  const heads = await git(cwd, ['for-each-ref', 'refs/heads', `--format=%(refname:short)${US}%(committerdate:unix)${US}%(subject)${US}%(upstream)${US}%(HEAD)`]).catch(() => '');
  const remoteHeads = new Map((await git(cwd, ['for-each-ref', 'refs/remotes/origin', `--format=%(refname:strip=3)${US}%(committerdate:unix)${US}%(subject)${US}%(symref)`]).catch(() => ''))
    .split('\n').filter(Boolean).map((line) => line.split(US))
    .filter(([name, , , symref]) => !symref && name !== 'designer-screenshots')
    .map(([name, date, title]) => [name, { name, updated: Number(date) * 1000, title, shared: true, current: false, remoteOnly: true }] as const));
  const variations: Variation[] = heads
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, date, title, upstream, head] = l.split(US);
      return { name, updated: Number(date) * 1000, title, shared: !!upstream || remoteHeads.has(name), current: head === '*' };
    })
  for (const variation of variations) remoteHeads.delete(variation.name);
  variations.push(...remoteHeads.values());
  variations.sort((a, b) => (a.name === base ? -1 : b.name === base ? 1 : b.updated - a.updated));
  return { branch: st.branch, main: base, versions, variations, unsaved: st.changed.length, ahead: st.ahead, behind: st.behind, remote: st.remote };
}

/** Saves whatever is unsaved as a version. Returns false when there was nothing to save. */
async function saveAll(cwd: string, title: string, description?: string) {
  await excludeReviews(cwd);
  await git(cwd, ['add', '-A']);
  if (!(await git(cwd, ['diff', '--cached', '--name-only'])).trim()) return false;
  await git(cwd, ['commit', '-q', '-m', title, ...(description?.trim() ? ['-m', description.trim()] : [])]);
  return true;
}

/** Figma's "Add to version history": saves the current state with a name and a description. */
export async function nameVersion(cwd: string, name: string, description = ''): Promise<ActionResult> {
  const title = name.trim();
  if (!title) return { ok: false, message: 'Give the version a name.' };
  try {
    await saveAll(cwd, title, description);
    if (!(await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()) return { ok: false, message: 'There is nothing to save yet.' };
    let tag = `version/${slugify(title) || 'version'}`;
    for (let i = 2; (await git(cwd, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`]).catch(() => '')).trim(); i++) tag = `version/${slugify(title) || 'version'}-${i}`;
    await git(cwd, ['tag', '-a', tag, '-m', title, ...(description.trim() ? ['-m', description.trim()] : [])]);
    return { ok: true, message: `Saved “${title}” to version history.` };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Files a version changed. */
export async function versionFiles(cwd: string, id: string) {
  if (!/^[0-9a-f]{4,40}$/i.test(id)) throw new Error('No such version');
  return (await git(cwd, ['show', '--name-status', '--format=', id]))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...p] = l.split('\t');
      return { status: status[0], path: p[p.length - 1] };
    });
}

/**
 * Figma's "Restore this version": the folder goes back to how it was then, as a new version on top,
 * so the history keeps everything in between. Unsaved work is saved first.
 */
export async function restoreVersion(cwd: string, id: string): Promise<ActionResult> {
  if (!/^[0-9a-f]{4,40}$/i.test(id)) return { ok: false, message: 'No such version.' };
  try {
    const title = (await git(cwd, ['log', '-1', '--format=%s', id])).trim();
    await saveAll(cwd, 'Before restoring an earlier version');
    await git(cwd, ['read-tree', '-u', '--reset', id]);
    const saved = await saveAll(cwd, `Restored “${title}”`, `Restored from version ${id.slice(0, 7)}.`);
    return { ok: true, message: saved ? `Restored “${title}”. It is now the latest version.` : `This is already how “${title}” looked.` };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Starts a variation from where you are (Figma's "Create branch"). Unsaved changes come along. */
export async function createVariation(cwd: string, name: string): Promise<ActionResult> {
  try {
    const ref = variationRef(name);
    if ((await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]).catch(() => '')).trim()) return { ok: false, message: `There is already a variation called ${ref}.` };
    await git(cwd, ['switch', '-c', ref]);
    return { ok: true, message: `You are now working on the variation “${name.trim()}”. The main design stays as it was.` };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Opens another variation. Unsaved work on this one is saved first, so nothing is lost. */
export async function switchVariation(cwd: string, name: string): Promise<ActionResult> {
  try {
    const st = await gitStatus(cwd);
    if (st.branch === name) return { ok: true, message: `You are already on ${name}.` };
    const local = (await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).catch(() => '')).trim();
    const remote = (await git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${name}`]).catch(() => '')).trim();
    if (!local && !remote) return { ok: false, message: `There is no variation called ${name}.` };
    if (!local && (await git(cwd, ['status', '--porcelain'])).trim()) {
      return { ok: false, message: 'Save or set aside your local changes before joining the team branch.' };
    }
    const saved = local && await saveAll(cwd, `Work in progress on ${st.branch ?? 'this variation'}`);
    await git(cwd, local ? ['switch', '--', name] : ['switch', '--track', '-c', name, `refs/remotes/origin/${name}`]);
    return { ok: true, message: `Opened ${name}.${saved ? ' Your unsaved changes were saved on the variation you left.' : ''}` };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Brings a variation's changes into the one you are on (Figma's "Merge branch"). */
export async function mergeVariation(cwd: string, name: string): Promise<ActionResult> {
  try {
    const st = await gitStatus(cwd);
    if (st.branch === name) return { ok: false, message: 'Open the variation you want to bring the changes into first.' };
    await saveAll(cwd, `Work in progress on ${st.branch ?? 'this variation'}`);
    try {
      await git(cwd, ['merge', '--no-edit', '-m', `Merged ${name} into ${st.branch}`, name]);
    } catch (e) {
      await git(cwd, ['merge', '--abort']).catch(() => undefined);
      throw e;
    }
    return { ok: true, message: `Brought the changes from ${name} into ${st.branch}.` };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Removes a variation whose changes are already in another one. Refuses to drop unmerged work. */
export async function deleteVariation(cwd: string, name: string): Promise<ActionResult> {
  try {
    const st = await gitStatus(cwd);
    if (st.branch === name) return { ok: false, message: 'Open another variation before removing this one.' };
    await git(cwd, ['branch', '-d', name]);
    return { ok: true, message: `Removed the variation ${name}.` };
  } catch (e) {
    const text = String((e as { stderr?: string }).stderr ?? '');
    if (/not fully merged/.test(text)) return { ok: false, message: `${name} has changes that are not in any other variation yet, so it was kept. Merge it first.` };
    return { ok: false, message: friendlyGitError(e) };
  }
}

/** Gets the team's changes, then sends yours (and your named versions). */
export async function syncWithTeam(cwd: string): Promise<ActionResult> {
  try {
    const st = await gitStatus(cwd);
    if (!st.remote) return { ok: false, message: 'This project has no team copy to sync with. Ask Claude in the chat to publish it to GitHub first.' };
    const saved = await saveAll(cwd, 'Design update');
    await git(cwd, ['fetch', '--prune', '--tags', 'origin']);
    const branch = st.branch ?? 'main';
    const up = (await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
    const onRemote = up || (await git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).catch(() => '')).trim();
    let got = 0;
    if (onRemote) {
      got = Number((await git(cwd, ['rev-list', '--count', `HEAD..${up || `origin/${branch}`}`])).trim()) || 0;
      if (got) {
        // Merge rather than rebase, so named versions keep pointing at the versions they named.
        try {
          await git(cwd, ['pull', '--no-rebase', '--no-edit', 'origin', branch]);
        } catch (e) {
          await git(cwd, ['merge', '--abort']).catch(() => undefined);
          throw e;
        }
      }
    }
    const ahead = onRemote ? Number((await git(cwd, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim()) || 0 : 1;
    if (ahead) await git(cwd, ['push', '--follow-tags', '-u', 'origin', branch]);
    else await git(cwd, ['push', '--tags', 'origin']).catch(() => undefined);
    const parts = [got ? `Got ${got} change${got === 1 ? '' : 's'} from the team.` : 'You already had the team’s latest.', ahead ? 'Sent your versions.' : '', saved ? 'Your unsaved changes were saved first.' : ''];
    return { ok: true, message: parts.filter(Boolean).join(' ') };
  } catch (e) {
    return { ok: false, message: friendlyGitError(e) };
  }
}
