// Canvas comments live in the project as one small JSON file per thread
// (.designer/comments/<id>.json). One file per thread means two people commenting at the same
// time never touch the same file, so their comments merge cleanly through git.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CanvasComment } from '../shared/protocol.js';

const run = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const commentsDir = (designerDir: string) => join(designerDir, 'comments');

/** Keeps only the fields a comment has, so stray data from a file or the UI is never written back. */
export function cleanComment(raw: unknown): CanvasComment | null {
  const c = raw as Partial<CanvasComment> | null;
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !SAFE_ID.test(c.id) || typeof c.text !== 'string') return null;
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    id: c.id,
    num: num(c.num),
    x: num(c.x),
    y: num(c.y),
    nodeId: typeof c.nodeId === 'string' ? c.nodeId : null,
    dx: num(c.dx),
    dy: num(c.dy),
    author: typeof c.author === 'string' && c.author ? c.author : 'Someone',
    text: c.text,
    at: num(c.at, Date.now()),
    resolved: !!c.resolved,
    replies: Array.isArray(c.replies)
      ? c.replies.filter((r) => r && typeof r.text === 'string').map((r) => ({ author: typeof r.author === 'string' && r.author ? r.author : 'Someone', text: r.text, at: num(r.at, Date.now()) }))
      : [],
  };
}

/**
 * Oldest first. Two people can each add "#4" on their own copies; after a merge the later one
 * takes the next free number so every pin stays distinct.
 */
export function numberComments(list: CanvasComment[]): CanvasComment[] {
  const sorted = [...list].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const used = new Set<number>();
  let max = sorted.reduce((m, c) => Math.max(m, c.num), 0);
  return sorted.map((c) => {
    let n = c.num;
    if (!n || used.has(n)) n = ++max;
    used.add(n);
    return n === c.num ? c : { ...c, num: n };
  });
}

export async function readComments(designerDir: string): Promise<CanvasComment[]> {
  const dir = commentsDir(designerDir);
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: CanvasComment[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const c = cleanComment(await readFile(join(dir, f), 'utf8').then((t) => JSON.parse(t) as unknown, () => null));
    if (c) out.push(c);
  }
  return numberComments(out);
}

const serialize = (c: CanvasComment) => JSON.stringify(c, null, 1) + '\n';

/** Writes the full list: changed threads are rewritten, removed ones deleted, unchanged ones left alone. */
export async function writeComments(designerDir: string, list: unknown[]): Promise<CanvasComment[]> {
  const dir = commentsDir(designerDir);
  const next = list.map(cleanComment).filter((c): c is CanvasComment => !!c);
  const files = await readdir(dir).catch(() => [] as string[]);
  const keep = new Set(next.map((c) => `${c.id}.json`));
  if (next.length) await mkdir(dir, { recursive: true });
  for (const c of next) {
    const file = join(dir, `${c.id}.json`);
    const text = serialize(c);
    if ((await readFile(file, 'utf8').catch(() => '')) !== text) await writeFile(file, text);
  }
  for (const f of files) if (f.endsWith('.json') && !keep.has(f)) await rm(join(dir, f), { force: true });
  return numberComments(next);
}

/** The name new comments are signed with: git's user.name for the project, else the OS user. */
export async function commentAuthor(cwd: string | undefined): Promise<string> {
  try {
    const { stdout } = await run('git', ['config', 'user.name'], { cwd: cwd ?? process.cwd(), timeout: 5000 });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Not a repo or no git: fall through.
  }
  return process.env.USER || process.env.USERNAME || 'You';
}

/** Plain-text summary of open comments, for Claude. */
export function describeComments(list: CanvasComment[], names: (nodeId: string | null) => string | undefined, includeResolved = false) {
  const shown = list.filter((c) => includeResolved || !c.resolved);
  if (!shown.length) return includeResolved ? 'There are no comments on the canvas.' : 'There are no open comments on the canvas.';
  return shown
    .map((c) => {
      const on = names(c.nodeId);
      const head = `#${c.num} (id ${c.id})${on ? ` on "${on}"${c.nodeId ? ` [layer ${c.nodeId}]` : ''}` : ''}${c.resolved ? ' [resolved]' : ''}: ${c.author}: ${c.text}`;
      return [head, ...c.replies.map((r) => `   reply from ${r.author}: ${r.text}`)].join('\n');
    })
    .join('\n');
}
