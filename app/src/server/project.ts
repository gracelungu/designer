import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GitStatus, MemoryFile, ProjectInfo, StoryEntry } from '../shared/protocol.js';

const run = promisify(execFile);

export async function git(cwd: string, args: string[], timeout = 60000) {
  const { stdout } = await run('git', args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/** Parse `git status --porcelain=v2 --branch` output. */
export function parseGitStatus(out: string): Omit<GitStatus, 'isRepo' | 'remote' | 'lastCommit'> {
  const s: Omit<GitStatus, 'isRepo' | 'remote' | 'lastCommit'> = { ahead: 0, behind: 0, changed: [] };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) s.branch = line.slice(14);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const path = line.startsWith('2 ') ? parts.slice(9).join(' ').split('\t')[0] : parts.slice(8).join(' ');
      s.changed.push({ path, status: parts[1].replace(/\./g, '') || 'M' });
    } else if (line.startsWith('? ')) s.changed.push({ path: line.slice(2), status: '?' });
  }
  return s;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  try {
    const out = await git(cwd, ['status', '--porcelain=v2', '--branch']);
    const remote = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim() || undefined;
    const lastCommit = (await git(cwd, ['log', '-1', '--format=%s']).catch(() => '')).trim() || undefined;
    return { isRepo: true, remote, lastCommit, ...parseGitStatus(out) };
  } catch {
    return { isRepo: false, ahead: 0, behind: 0, changed: [] };
  }
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'storybook-static', '.turbo']);

async function walk(dir: string, match: (f: string) => boolean, acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || acc.length > 500) return acc;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.storybook') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) await walk(p, match, acc, depth + 1);
    } else if (match(e.name)) acc.push(p);
  }
  return acc;
}

/** Storybook's id rules: lowercase, non-alphanumerics to dashes. */
export function sanitizeStoryId(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Words from an export name, the way Storybook titles stories ("PrimaryLarge" -> "Primary Large"). */
export function storyNameFromExport(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

/** Read a CSF file's title and named story exports without executing it. */
export function parseStoriesFile(source: string, relPath: string): StoryEntry {
  const titleMatch = /title\s*:\s*['"`]([^'"`]+)['"`]/.exec(source);
  const fallback = relPath
    .replace(/\\/g, '/')
    .replace(/^src\//, '')
    .replace(/\.stories\.[jt]sx?$/, '')
    .replace(/\/index$/, '');
  const title = titleMatch ? titleMatch[1] : fallback;
  const stories: StoryEntry['stories'] = [];
  const re = /export\s+(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(source))) {
    const exportName = m[1];
    if (exportName === 'default' || exportName === '__namedExportsOrder') continue;
    const name = storyNameFromExport(exportName);
    stories.push({ exportName, name, id: `${sanitizeStoryId(title)}--${sanitizeStoryId(name)}` });
  }
  return { file: relPath, title, stories };
}

export async function findStories(cwd: string): Promise<StoryEntry[]> {
  const files = await walk(cwd, (f) => /\.stories\.[jt]sx?$/.test(f));
  const out: StoryEntry[] = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8').catch(() => '');
    out.push(parseStoriesFile(src, relative(cwd, f)));
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export async function projectInfo(cwd: string): Promise<ProjectInfo> {
  const pkg = await readFile(join(cwd, 'package.json'), 'utf8')
    .then((t) => JSON.parse(t) as { name?: string; scripts?: Record<string, string> })
    .catch(() => ({}) as { name?: string; scripts?: Record<string, string> });
  return { path: cwd, name: basename(cwd), git: await gitStatus(cwd), scripts: pkg.scripts ?? {}, stories: await findStories(cwd) };
}

export function memoryPaths(cwd: string, home = homedir()) {
  return [
    { scope: 'project' as const, path: join(cwd, 'CLAUDE.md') },
    { scope: 'project' as const, path: join(cwd, '.claude', 'CLAUDE.md') },
    { scope: 'project-local' as const, path: join(cwd, 'CLAUDE.local.md') },
    { scope: 'user' as const, path: join(home, '.claude', 'CLAUDE.md') },
  ];
}

export async function readMemory(cwd: string): Promise<MemoryFile[]> {
  return Promise.all(
    memoryPaths(cwd).map(async (m) => {
      const content = await readFile(m.path, 'utf8').catch(() => null);
      return { ...m, exists: content !== null, content: content ?? '' };
    }),
  );
}

export async function writeMemory(cwd: string, path: string, content: string) {
  if (!memoryPaths(cwd).some((m) => m.path === path)) throw new Error('Not a Claude memory file for this project');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function listDir(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const isRepo = await stat(join(path, '.git')).then(() => true, () => false);
  return { path, parent: dirname(path) === path ? null : dirname(path), dirs, isRepo, sep };
}

// ----- Designer-friendly git: Get latest, Save version, Share for review -----

export async function getLatest(cwd: string) {
  const st = await gitStatus(cwd);
  if (!st.remote) return { ok: false, message: 'This project has no remote to get updates from.' };
  await git(cwd, ['fetch', '--prune', 'origin']);
  const stashed = st.changed.length > 0;
  if (stashed) await git(cwd, ['stash', 'push', '--include-untracked', '-m', 'designer: before get latest']);
  try {
    const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
    const out = upstream ? await git(cwd, ['pull', '--rebase']) : await git(cwd, ['pull', '--rebase', 'origin', st.branch ?? 'main']);
    return { ok: true, message: out.trim() || 'Up to date.' };
  } finally {
    if (stashed) await git(cwd, ['stash', 'pop']).catch(() => undefined);
  }
}

export async function saveVersion(cwd: string, message: string) {
  await git(cwd, ['add', '-A']);
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return { ok: false, message: 'Nothing has changed since the last version.' };
  await git(cwd, ['commit', '-m', message || 'Design update']);
  return { ok: true, message: `Saved ${staged.split('\n').length} file(s).` };
}

export async function shareForReview(cwd: string, title: string) {
  const st = await gitStatus(cwd);
  if (!st.remote) return { ok: false, message: 'This project has no remote to share to.' };
  let branch = st.branch ?? 'HEAD';
  const def = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).trim().replace(/^origin\//, '');
  if (branch === def) {
    branch = `design/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
    await git(cwd, ['switch', '-c', branch]);
  }
  await git(cwd, ['push', '-u', 'origin', branch]);
  try {
    const { stdout } = await run('gh', ['pr', 'create', '--fill', '--title', title || `Design update from ${branch}`, '--head', branch], { cwd, timeout: 60000 });
    return { ok: true, message: 'Opened a pull request.', url: stdout.trim().split('\n').pop() };
  } catch (e) {
    const err = e as { stderr?: string };
    const existing = /https:\/\/\S+\/pull\/\d+/.exec(err.stderr ?? '');
    if (existing) return { ok: true, message: 'A pull request is already open for this branch.', url: existing[0] };
    const web = st.remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
    return { ok: true, message: 'Pushed. Open the link to create the pull request.', url: `${web}/compare/${def}...${branch}?expand=1` };
  }
}

export async function diffFor(cwd: string, path: string) {
  const before = await git(cwd, ['show', `HEAD:${path}`]).catch(() => '');
  const after = await readFile(join(cwd, path), 'utf8').catch(() => '');
  return { path, before, after };
}

// ----- Dev servers (the app itself and Storybook) -----

/** First local URL a dev server prints, without trailing slash or punctuation. */
export function findLocalUrl(text: string): string | undefined {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s)'"`,]*)?/.exec(text);
  return m ? m[0].replace(/[/.]+$/, '') : undefined;
}

export class DevProcess {
  proc?: ChildProcess;
  url?: string;
  log: string[] = [];
  constructor(readonly script: string) {}
  start(cwd: string): Promise<string> {
    if (this.proc && this.url) return Promise.resolve(this.url);
    return new Promise((resolveUrl, reject) => {
      const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', this.script], { cwd, env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' } });
      this.proc = p;
      const timer = setTimeout(() => reject(new Error(`"npm run ${this.script}" did not print a local URL within 90 seconds.`)), 90000);
      const onData = (d: Buffer) => {
        // eslint-disable-next-line no-control-regex
        const text = d.toString().replace(/\x1b\[[0-9;]*m/g, '');
        this.log.push(text);
        if (this.log.length > 300) this.log.shift();
        const m = findLocalUrl(text);
        if (m && !this.url) {
          this.url = m;
          clearTimeout(timer);
          resolveUrl(this.url);
        }
      };
      p.stdout?.on('data', onData);
      p.stderr?.on('data', onData);
      p.on('exit', (code) => {
        clearTimeout(timer);
        this.proc = undefined;
        this.url = undefined;
        reject(new Error(`"npm run ${this.script}" exited with code ${code}.\n${this.log.slice(-10).join('')}`));
      });
    });
  }
  stop() {
    this.proc?.kill();
    this.proc = undefined;
    this.url = undefined;
  }
}
