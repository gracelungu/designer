import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVariation, deleteVariation, history, mergeVariation, nameVersion, parseLog, restoreVersion, slugify, switchVariation, syncWithTeam, variationRef, versionFiles } from '../src/server/versions';
import { githubLikeProject } from './fixtures/repo';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim();
const css = (dir: string, v?: string) => (v === undefined ? readFileSync(join(dir, 'src', 'Button.css'), 'utf8') : writeFileSync(join(dir, 'src', 'Button.css'), v));

describe('version helpers', () => {
  it('names variations the way git allows', () => {
    expect(slugify('Dark mode, v2!')).toBe('dark-mode-v2');
    expect(variationRef('Dark mode')).toBe('design/dark-mode');
    expect(variationRef('feature/login')).toBe('feature/login');
    expect(() => variationRef('!!!')).toThrow();
  });

  it('parses the log', () => {
    const US = '\x1f';
    const RS = '\x1e';
    const out = `${RS}abc${US}a${US}Blue button${US}Body here\n${US}Dana${US}1700000000${US}\n\nsrc/a.css\nsrc/b.css\n${RS}def${US}d${US}First${US}${US}Dana${US}1690000000${US}\n\nREADME.md\n`;
    expect(parseLog(out)).toEqual([
      { id: 'abc', short: 'a', title: 'Blue button', description: 'Body here', author: 'Dana', date: 1700000000000, files: 2 },
      { id: 'def', short: 'd', title: 'First', description: undefined, author: 'Dana', date: 1690000000000, files: 1 },
    ]);
  });
});

describe('version history backed by git', () => {
  it('lists versions, names one, and shows its files', async () => {
    const { dir } = githubLikeProject();
    css(dir, 'blue\n');
    let h = await history(dir);
    expect(h).toMatchObject({ branch: 'main', main: 'main', unsaved: 1 });
    expect(h.versions.map((v) => v.title)).toEqual(['First']);
    expect(h.versions[0]).toMatchObject({ author: 'T', local: false, files: 1 });

    expect(await nameVersion(dir, '  ')).toMatchObject({ ok: false });
    expect(await nameVersion(dir, 'Blue button', 'Brand refresh')).toMatchObject({ ok: true });
    h = await history(dir);
    expect(h.unsaved).toBe(0);
    expect(h.versions[0]).toMatchObject({ title: 'Blue button', name: 'Blue button', description: 'Brand refresh', local: true });
    expect(git(dir, 'tag', '-l')).toBe('version/blue-button');
    // Same name again gets its own tag.
    expect((await nameVersion(dir, 'Blue button')).ok).toBe(true);
    expect(git(dir, 'tag', '-l').split('\n')).toEqual(['version/blue-button', 'version/blue-button-2']);
    expect(await versionFiles(dir, h.versions[0].id)).toEqual([{ status: 'M', path: 'src/Button.css' }]);
    await expect(versionFiles(dir, '; rm -rf /')).rejects.toThrow();
  });

  it('restores an old version as a new one, keeping history and unsaved work', async () => {
    const { dir } = githubLikeProject();
    const first = git(dir, 'rev-parse', 'HEAD');
    css(dir, 'blue\n');
    writeFileSync(join(dir, 'src', 'New.css'), 'new\n');
    await nameVersion(dir, 'Blue');
    css(dir, 'green\n');
    const r = await restoreVersion(dir, first);
    expect(r).toMatchObject({ ok: true });
    expect(css(dir)).toBe('.btn { color: red; }\n');
    expect(existsSync(join(dir, 'src', 'New.css'))).toBe(false);
    expect(git(dir, 'log', '--format=%s')).toBe('Restored “First”\nBefore restoring an earlier version\nBlue\nFirst');
    // The green work is still in history.
    expect(git(dir, 'show', 'HEAD~1:src/Button.css')).toBe('green');
    expect((await restoreVersion(dir, 'nope')).ok).toBe(false);
  });

  it('creates, switches, merges and removes variations without losing work', async () => {
    const { dir } = githubLikeProject();
    expect(await createVariation(dir, 'Dark mode')).toMatchObject({ ok: true });
    expect((await createVariation(dir, 'Dark mode')).ok).toBe(false);
    css(dir, 'dark\n');
    // Switching saves the unsaved change on the variation being left.
    const sw = await switchVariation(dir, 'main');
    expect(sw.message).toMatch(/saved on the variation you left/);
    expect(css(dir)).toBe('.btn { color: red; }\n');
    let h = await history(dir);
    expect(h.variations.map((v) => [v.name, v.current, v.shared])).toEqual([
      ['main', true, true],
      ['design/dark-mode', false, false],
    ]);
    // Not merged yet, so it can't be removed.
    expect((await deleteVariation(dir, 'design/dark-mode')).message).toMatch(/kept/);
    expect(await mergeVariation(dir, 'design/dark-mode')).toMatchObject({ ok: true });
    expect(css(dir)).toBe('dark\n');
    expect(await deleteVariation(dir, 'design/dark-mode')).toMatchObject({ ok: true });
    h = await history(dir);
    expect(h.variations.map((v) => v.name)).toEqual(['main']);
    expect((await switchVariation(dir, 'nope')).ok).toBe(false);
  });

  it('backs out of a conflicting merge and says why', async () => {
    const { dir } = githubLikeProject();
    await createVariation(dir, 'A');
    css(dir, 'a\n');
    await switchVariation(dir, 'main');
    css(dir, 'b\n');
    const r = await mergeVariation(dir, 'design/a');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/same lines/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(css(dir)).toBe('b\n');
  });

  it('syncs with the team: gets their changes, then sends yours with named versions', async () => {
    const { root, bare, dir } = githubLikeProject();
    // A teammate pushes a change.
    const mate = join(root, 'mate');
    execFileSync('git', ['clone', '-q', bare, mate]);
    git(mate, 'config', 'user.name', 'Sam');
    git(mate, 'config', 'user.email', 'sam@example.com');
    mkdirSync(join(mate, 'docs'), { recursive: true });
    writeFileSync(join(mate, 'docs', 'note.md'), 'hi\n');
    git(mate, 'add', '-A');
    git(mate, 'commit', '-q', '-m', 'Note from Sam');
    git(mate, 'push', '-q');

    css(dir, 'blue\n');
    await nameVersion(dir, 'Blue');
    const r = await syncWithTeam(dir);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/Got 1 change from the team/);
    expect(r.message).toMatch(/Sent your versions/);
    expect(git(bare, 'log', '--format=%s', 'main').split('\n')).toEqual(expect.arrayContaining(['Blue', 'Note from Sam', 'First']));
    expect(git(bare, 'tag', '-l')).toBe('version/blue');
    expect(existsSync(join(dir, 'docs', 'note.md'))).toBe(true);
    const again = await syncWithTeam(dir);
    expect(again.message).toMatch(/already had the team’s latest/);
  });

  it('pushes a new variation to the team on sync', async () => {
    const { bare, dir } = githubLikeProject();
    await createVariation(dir, 'Pricing');
    css(dir, 'p\n');
    expect((await syncWithTeam(dir)).ok).toBe(true);
    expect(git(bare, 'log', '--format=%s', 'design/pricing')).toBe('Design update\nFirst');
    const h = await history(dir);
    expect(h.variations.find((v) => v.name === 'design/pricing')?.shared).toBe(true);
  });

  it('explains when there is no history or no team copy', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'designer-nogit-')));
    await expect(history(plain)).rejects.toThrow(/no version history/);
    const { dir } = githubLikeProject();
    git(dir, 'remote', 'remove', 'origin');
    expect((await syncWithTeam(dir)).message).toMatch(/no team copy/);
    const h = await history(dir);
    expect(h.versions[0].local).toBe(true);
  });
});
