import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkspaceManifest, WorkspaceTracking } from '../shared/protocol.js';
import { git } from './project.js';

export const WORKSPACE_MANIFEST = '.designer/workspace.json';
const MAX_BYTES = 16_384;
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function directory(cwd: string) {
  const dir = join(cwd, '.designer');
  const info = await lstat(dir).catch((error) => { if (!missing(error)) throw error; });
  if (info && !info.isDirectory()) throw new Error('.designer must be a directory inside the project.');
  return dir;
}

async function readManifest(cwd: string): Promise<WorkspaceManifest | null> {
  const dir = await directory(cwd);
  const file = join(dir, 'workspace.json');
  const info = await lstat(file).catch((error) => { if (!missing(error)) throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('The workspace manifest must be a small regular file.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('The workspace manifest is too large.');
    const value: Partial<WorkspaceManifest> | null = JSON.parse(raw.toString('utf8', 0, bytesRead));
    if (value?.format !== 'designer-workspace' || value.version !== 1 || typeof value.id !== 'string' || !ID.test(value.id)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) {
      throw new Error('Designer cannot read this version of the workspace manifest.');
    }
    return value as WorkspaceManifest;
  } finally {
    await handle.close();
  }
}

async function branchAtRoot(cwd: string) {
  const [prefix, branch] = await Promise.all([
    git(cwd, ['rev-parse', '--show-prefix']),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
  ]);
  if (prefix.trim() || !branch.trim()) throw new Error('Open the repository root on a branch to track a shared workspace.');
  return branch.trim();
}

export async function workspaceTracking(cwd: string): Promise<WorkspaceTracking> {
  const blank = { manifest: null, tracked: false, pending: false, defaultName: basename(cwd), canvasTracked: false, commentThreads: 0, reason: null };
  try {
    await branchAtRoot(cwd);
    const [manifest, indexed, changes, conflicts] = await Promise.all([
      readManifest(cwd),
      git(cwd, ['ls-files', '-z', '--', WORKSPACE_MANIFEST, '.designer/canvas.json', ':(glob).designer/comments/*.json']),
      git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', WORKSPACE_MANIFEST]),
      git(cwd, ['ls-files', '--unmerged', '--', WORKSPACE_MANIFEST]),
    ]);
    const files = new Set(indexed.split('\0').filter(Boolean));
    const tracked = files.has(WORKSPACE_MANIFEST);
    const canvasTracked = files.has('.designer/canvas.json');
    const commentThreads = [...files].filter((path) => /^\.designer\/comments\/[\w-]{1,64}\.json$/.test(path)).length;
    const ignored = !tracked && !!(await git(cwd, ['check-ignore', '--', WORKSPACE_MANIFEST]).catch(() => '')).trim();
    return { ...blank, manifest, tracked, canvasTracked, commentThreads, pending: !!changes.trim(),
      reason: conflicts.trim() ? 'Resolve the workspace manifest conflict in Git before editing.'
        : ignored ? 'Git ignores .designer/workspace.json. Allow it in your repository’s ignore rules first.' : null };
  } catch (error) {
    return { ...blank, reason: (error as Error).message };
  }
}

/** Stage just the workspace manifest after the user explicitly creates or updates it. */
export async function trackWorkspace(cwd: string, branch: string, name: string, expectedId: string | null) {
  if (await branchAtRoot(cwd) !== branch) throw new Error('The active branch changed. Open the workspace settings again.');
  const label = name.trim();
  if (!label || label.length > 100) throw new Error('Enter a workspace name between 1 and 100 characters.');
  const state = await workspaceTracking(cwd);
  if (state.reason) throw new Error(state.reason);
  const previous = state.manifest;
  if ((previous?.id ?? null) !== expectedId) throw new Error('The workspace changed. Refresh its settings before editing.');
  const dir = await directory(cwd);
  const file = join(dir, 'workspace.json');
  const next: WorkspaceManifest = { ...previous, format: 'designer-workspace', version: 1, id: previous?.id ?? randomUUID(), name: label };
  if (!previous || previous.name !== label) {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.workspace-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      if (previous) await rename(temp, file);
      else await link(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }
  await git(cwd, ['add', '--', WORKSPACE_MANIFEST]);
  return workspaceTracking(cwd);
}
