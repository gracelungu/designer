import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchTeamBranches, setTeamSync, syncDesignBranch, teamSyncStatus } from '../src/server/teamSync';
import { trackWorkspace, workspaceTracking, WORKSPACE_MANIFEST } from '../src/server/workspaceTracking';
import { history, switchVariation } from '../src/server/versions';

const branch = 'design/new-navigation';
const canvas = '.designer/canvas.json';
let root: string, remote: string, alice: string, bob: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (cwd: string, file: string, text: string) => {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), text);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'designer-team-')));
  remote = join(root, 'remote.git');
  alice = join(root, 'alice');
  bob = join(root, 'bob');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, alice);
  git(alice, 'config', 'user.name', 'Alice');
  git(alice, 'config', 'user.email', 'alice@example.invalid');
  put(alice, 'app.txt', 'initial code');
  git(alice, 'add', '.');
  git(alice, 'commit', '-m', 'Initial code');
  git(alice, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, bob);
  git(bob, 'config', 'user.name', 'Bob');
  git(bob, 'config', 'user.email', 'bob@example.invalid');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Git design collaboration', () => {
  it('lets a teammate discover, join and receive changes on a published branch', async () => {
    git(alice, 'switch', '-c', branch);
    await setTeamSync(alice, true, branch);
    put(alice, canvas, '{"name":"Navigation"}');
    put(alice, '.designer/comments/thread.json', '{"text":"Review navigation"}');
    put(alice, 'app.txt', 'unfinished code');
    git(alice, 'add', 'app.txt');
    put(alice, 'private.txt', 'untracked notes');

    expect(await syncDesignBranch(alice, branch, true)).toMatchObject({ ok: true, changed: false });
    expect(git(alice, 'diff', '--cached', '--name-only')).toBe('app.txt');
    expect(git(remote, 'show', `refs/heads/${branch}:app.txt`)).toBe('initial code');
    expect(git(remote, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)).not.toContain('private.txt');
    await fetchTeamBranches(bob);
    expect((await history(bob)).variations).toContainEqual(expect.objectContaining({ name: branch, remoteOnly: true }));
    expect(await switchVariation(bob, branch)).toMatchObject({ ok: true });
    expect(readFileSync(join(bob, canvas), 'utf8')).toContain('Navigation');
    expect(readFileSync(join(bob, '.designer/comments/thread.json'), 'utf8')).toContain('Review navigation');

    put(alice, canvas, '{"name":"New navigation"}');
    expect(await syncDesignBranch(alice, branch, true)).toMatchObject({ ok: true });
    put(bob, 'notes.txt', 'Local work');
    expect(await syncDesignBranch(bob, branch, false)).toMatchObject({
      ok: false, changed: false, message: expect.stringContaining('local changes'),
    });
    expect(readFileSync(join(bob, 'notes.txt'), 'utf8')).toBe('Local work');
    rmSync(join(bob, 'notes.txt'));
    expect(await syncDesignBranch(bob, branch, false)).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(join(bob, canvas), 'utf8')).toContain('New navigation');
  });

  it('keeps an existing manifest private until it is tracked and preserves its ID when renamed', async () => {
    git(alice, 'switch', '-c', branch);
    expect(await workspaceTracking(alice)).toMatchObject({ manifest: null, tracked: false });
    expect(existsSync(join(alice, WORKSPACE_MANIFEST))).toBe(false);
    const id = '02d79a85-c9a6-4d5e-a42d-59caadde03a5';
    put(alice, WORKSPACE_MANIFEST, JSON.stringify({ format: 'designer-workspace', version: 1, id, name: 'Private draft' }));
    expect(await syncDesignBranch(alice, branch, false)).toMatchObject({ ok: true });
    expect(git(remote, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)).not.toContain(WORKSPACE_MANIFEST);
    expect(await trackWorkspace(alice, branch, 'Product', id)).toMatchObject({ manifest: { id, name: 'Product' }, tracked: true, pending: true });
    expect(git(alice, 'diff', '--cached', '--name-only')).toBe(WORKSPACE_MANIFEST);
    expect(await syncDesignBranch(alice, branch, false)).toMatchObject({ ok: true });
    expect(JSON.parse(git(remote, 'show', `refs/heads/${branch}:${WORKSPACE_MANIFEST}`))).toMatchObject({ id, name: 'Product' });
  });

  it('respects ignore rules and leaves unsupported manifest versions alone', async () => {
    git(alice, 'switch', '-c', branch);
    put(alice, '.gitignore', '.designer/\n');
    await expect(trackWorkspace(alice, branch, 'Private', null)).rejects.toThrow('Git ignores');
    expect(existsSync(join(alice, WORKSPACE_MANIFEST))).toBe(false);
    rmSync(join(alice, '.gitignore'));
    put(alice, WORKSPACE_MANIFEST, '{"version":99}');
    await expect(trackWorkspace(alice, branch, 'Product', null)).rejects.toThrow('cannot read');
    expect(readFileSync(join(alice, WORKSPACE_MANIFEST), 'utf8')).toBe('{"version":99}');
  });

  it('requires explicit branch opt in and stops on divergence or unpublished code', async () => {
    expect((await teamSyncStatus(alice)).reason).toContain('default branch');
    expect(await syncDesignBranch(alice, 'main', false)).toMatchObject({ ok: false });
    git(alice, 'switch', '-c', branch);
    expect(await syncDesignBranch(alice, branch, true)).toMatchObject({ ok: false });
    put(alice, canvas, '{"name":"First"}');
    expect(await syncDesignBranch(alice, branch, false)).toMatchObject({ ok: true });
    await fetchTeamBranches(bob);
    expect(await switchVariation(bob, branch)).toMatchObject({ ok: true });

    put(bob, canvas, '{"name":"Bob"}');
    expect(await syncDesignBranch(bob, branch, false)).toMatchObject({ ok: true });
    put(alice, canvas, '{"name":"Alice"}');
    expect(await syncDesignBranch(alice, branch, false)).toMatchObject({ ok: false, changed: false, message: expect.stringContaining('Both copies') });
    expect(readFileSync(join(alice, canvas), 'utf8')).toContain('Alice');

    put(bob, 'app.txt', 'local code commit');
    git(bob, 'commit', '-am', 'Unpublished code');
    expect(await syncDesignBranch(bob, branch, false)).toMatchObject({ ok: false, message: expect.stringContaining('local code commits') });
    expect(git(remote, 'show', `refs/heads/${branch}:app.txt`)).toBe('initial code');
  });
});
