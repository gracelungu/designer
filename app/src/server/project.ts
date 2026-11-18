import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { indexComponents } from './setup.js';
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
  const stories = await findStories(cwd);
  return { path: cwd, name: basename(cwd), git: await gitStatus(cwd), scripts: pkg.scripts ?? {}, stories, components: await indexComponents(cwd, stories) };
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
/** An interactive prompt (inquirer/prompts style: "? Question … (Y/n)") that the dev server is waiting on. */
export function waitingForAnswer(output: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const m = /^\s*\?\s+(.+?(?:\(y\/N\)|\(Y\/n\)|\(yes\/no\)|›.*))\s*$/im.exec(clean);
  return m ? m[1].replace(/\s*›\s*$/, '').trim() : undefined;
}

export function findLocalUrl(text: string): string | undefined {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s)'"`,]*)?/.exec(text);
  return m ? m[0].replace(/[/.]+$/, '') : undefined;
}

/** Ports a Storybook for this project might already be on: the one in its script, then Storybook's defaults. */
export function storybookPorts(script?: string): number[] {
  const m = script ? /(?:-p|--port)[\s=]+(\d{2,5})/.exec(script) : null;
  return [...new Set([...(m ? [Number(m[1])] : []), 6006, 6007, 6008, 6009])];
}

/**
 * Finds a Storybook that is already running for this project (say, in the user's own terminal),
 * so Designer can use it instead of starting a second copy. It only counts as this project's
 * when its story index lists story files that this project has.
 */
export async function findRunningStorybook(projectFiles: string[], script?: string, hosts = ['127.0.0.1', 'localhost']): Promise<string | undefined> {
  const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');
  const mine = projectFiles.map(norm);
  if (!mine.length) return undefined;
  const ours = (importPath: string) => {
    const p = norm(importPath);
    return mine.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`));
  };
  for (const port of storybookPorts(script)) {
    for (const host of hosts) {
      const base = `http://${host}:${port}`;
      try {
        const r = await fetch(`${base}/index.json`, { signal: AbortSignal.timeout(1200) });
        if (!r.ok) continue;
        const idx = (await r.json()) as { entries?: Record<string, { importPath?: string }> };
        if (Object.values(idx.entries ?? {}).some((e) => e.importPath && ours(e.importPath))) return base;
        break; // a Storybook, but another project's
      } catch {
        // nothing on this host and port
      }
    }
  }
  return undefined;
}

export class DevProcess {
  proc?: ChildProcess;
  url?: string;
  /** Set when the server was already running (started outside Designer): we use it and never stop it. */
  adopted = false;
  command?: string;
  cwd?: string;
  log: string[] = [];
  constructor(readonly script: string) {}
  /** Starts a dev server and resolves with the first local URL it prints. Any shell command works; the default is `npm run <script>`. */
  start(cwd: string, command?: string, env: Record<string, string> = {}): Promise<string> {
    // Storybook asks yes/no questions in a terminal (e.g. "Port 6006 is not available, use 6007?"). Nobody
    // can answer them here, so run it with --ci: it then takes the next free port and never waits for input.
    const cmd = command?.trim() || (this.script === 'storybook' ? 'npm run storybook -- --ci' : `npm run ${this.script}`);
    if (this.proc && this.url && this.cwd === cwd && this.command === cmd) return Promise.resolve(this.url);
    if (this.adopted && this.url && this.cwd === cwd && !command) return Promise.resolve(this.url);
    this.stop();
    this.command = cmd;
    this.cwd = cwd;
    this.log = [];
    return new Promise((resolveUrl, reject) => {
      const p = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', PYTHONUNBUFFERED: '1', ...env } });
      this.proc = p;
      const timer = setTimeout(() => reject(new Error(`"${cmd}" did not print a local URL within 3 minutes.\n${this.tail()}`)), 180000);
      const onData = (d: Buffer) => {
        // eslint-disable-next-line no-control-regex
        const text = d.toString().replace(/\x1b\[[0-9;]*m/g, '');
        this.log.push(text);
        if (this.log.length > 300) this.log.shift();
        const question = !this.url && waitingForAnswer(this.log.join(''));
        if (question && this.proc === p) {
          clearTimeout(timer);
          this.stop();
          reject(new Error(`"${cmd}" stopped to ask a question in the terminal, which Designer can't answer:\n${question}\nRun it once in a terminal to answer it, or ask Claude to change the script.`));
          return;
        }
        const m = findLocalUrl(text);
        if (m && !this.url && this.proc === p) {
          this.url = m;
          clearTimeout(timer);
          resolveUrl(this.url);
        }
      };
      p.stdout?.on('data', onData);
      p.stderr?.on('data', onData);
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc !== p) return;
        this.proc = undefined;
        this.url = undefined;
        reject(new Error(`"${cmd}" exited with code ${code}.\n${this.tail()}`));
      });
    });
  }
  tail(lines = 12) {
    return this.log.join('').split('\n').slice(-lines).join('\n');
  }
  /** Use a server that is already running (not ours to stop). */
  adopt(cwd: string, url: string) {
    this.stop();
    this.cwd = cwd;
    this.url = url;
    this.adopted = true;
  }
  stop() {
    const p = this.proc;
    this.proc = undefined;
    this.url = undefined;
    this.adopted = false;
    if (!p) return;
    try {
      // Dev servers start children of their own; stop the whole group.
      if (p.pid && process.platform !== 'win32') process.kill(-p.pid, 'SIGTERM');
      else p.kill();
    } catch {
      p.kill();
    }
  }
}
