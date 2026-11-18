import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString().trim();

/**
 * A project whose origin looks like GitHub (https://github.com/acme/site.git) but is a bare repo
 * on disk, through git's url.insteadOf, so pushes are real and checkable.
 */
export function githubLikeProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'designer-share-')));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const dir = join(root, 'site');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Dana');
  git(dir, 'config', 'user.email', 'dana@example.com');
  git(dir, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/site.git');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/site.git');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'Button.css'), '.btn { color: red; }\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'First');
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return { root, bare, dir };
}

/** A stand-in gh that records what it was asked and answers like gh does. */
export function fakeGh(root: string, mode: 'ok' | 'exists' | 'fail' = 'ok') {
  const log = join(root, 'gh.log');
  const bin = join(root, 'gh');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const bf = a.indexOf('--body-file');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, body: bf >= 0 ? fs.readFileSync(a[bf + 1], 'utf8') : '' }) + '\\n');
if (${JSON.stringify(mode)} === 'fail') { process.stderr.write('gh: not logged in'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'create' && ${JSON.stringify(mode)} === 'exists') { process.stderr.write('a pull request for branch "x" into branch "main" already exists:\\nhttps://github.com/acme/site/pull/7\\n'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'create') console.log('https://github.com/acme/site/pull/12');
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; body: string }) };
}

