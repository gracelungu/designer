// The demo project bundled with Designer, so people can try it without a repo of their own.
// It is copied into Designer's folder (so edits never touch the app bundle) and made a git
// repository, so "Save version" works on it from the start.
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { git } from './project.js';

export const DEMO_NAME = 'Lumen demo';

/** Files and folders never copied out of the bundle. */
const SKIP = new Set(['node_modules', 'dist', 'storybook-static', '.DS_Store']);

export async function demoAvailable(src: string | undefined): Promise<boolean> {
  if (!src) return false;
  return stat(join(src, 'package.json')).then((s) => s.isFile(), () => false);
}

async function isEmptyOrMissing(dir: string) {
  const entries = await readdir(dir).catch(() => null);
  return !entries || entries.length === 0;
}

/**
 * Copy the bundled demo into `<workspace>/Lumen demo` and return its path.
 * If the copy already exists, it is reused as is (the user's edits are kept),
 * unless `fresh` is set, in which case a new numbered copy is made.
 */
export async function installDemo(src: string, workspace: string, opts: { fresh?: boolean } = {}): Promise<{ path: string; created: boolean }> {
  if (!(await demoAvailable(src))) throw new Error('The demo project is not bundled with this copy of Designer.');
  await mkdir(workspace, { recursive: true });
  let target = join(workspace, DEMO_NAME);
  if (!(await isEmptyOrMissing(target))) {
    if (!opts.fresh) return { path: target, created: false };
    for (let n = 2; !(await isEmptyOrMissing(target)); n++) target = join(workspace, `${DEMO_NAME} ${n}`);
  }
  await cp(src, target, { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
  await initRepo(target);
  return { path: target, created: true };
}

/** Make the copy a git repository with one commit. Without git (no Xcode tools yet), it stays a plain folder. */
async function initRepo(dir: string) {
  try {
    await git(dir, ['init', '-q', '-b', 'main']);
    // A new Mac often has no git name yet; give the demo one so Save version works.
    const named = await git(dir, ['config', 'user.email']).then((v) => !!v.trim(), () => false);
    if (!named) {
      await git(dir, ['config', 'user.name', 'Designer']);
      await git(dir, ['config', 'user.email', 'designer@localhost']);
    }
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Start from the Designer demo']);
  } catch {
    // A plain folder still works; only versions need git.
  }
}
