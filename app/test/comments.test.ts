import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanComment, commentAuthor, describeComments, numberComments, readComments, writeComments } from '../src/server/comments';
import type { CanvasComment } from '../src/shared/protocol';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'designer-comments-')));
const c = (over: Partial<CanvasComment> = {}): CanvasComment => ({ id: 'c1', num: 1, x: 10, y: 20, nodeId: 'frame1', dx: 5, dy: 6, author: 'Ada', text: 'Tighten the spacing', at: 1000, resolved: false, replies: [], ...over });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });

describe('comment files', () => {
  it('keeps only known fields and refuses unsafe ids', () => {
    const clean = cleanComment({ ...c(), extra: 'x', replies: [{ author: 'Bo', text: 'ok', at: 2, junk: true }, { nope: 1 }] });
    expect(clean).toEqual({ ...c(), replies: [{ author: 'Bo', text: 'ok', at: 2 }] });
    expect(cleanComment({ ...c(), id: '../../etc/passwd' })).toBeNull();
    expect(cleanComment({ id: 'a' })).toBeNull();
    expect(cleanComment(null)).toBeNull();
  });

  it('gives clashing numbers from two people the next free number, oldest first', () => {
    const out = numberComments([c({ id: 'b', num: 4, at: 20 }), c({ id: 'a', num: 4, at: 10 }), c({ id: 'z', num: 2, at: 5 })]);
    expect(out.map((x) => [x.id, x.num])).toEqual([['z', 2], ['a', 4], ['b', 5]]);
  });

  it('writes one file per thread, rewrites only changed ones, and deletes removed ones', async () => {
    const dir = tmp();
    await writeComments(dir, [c({ id: 'a' }), c({ id: 'b', num: 2, at: 2000 })]);
    expect(readdirSync(join(dir, 'comments')).sort()).toEqual(['a.json', 'b.json']);
    const before = statSync(join(dir, 'comments', 'a.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await writeComments(dir, [c({ id: 'a' }), c({ id: 'b', num: 2, at: 2000, resolved: true })]);
    expect(statSync(join(dir, 'comments', 'a.json')).mtimeMs).toBe(before);
    expect(JSON.parse(readFileSync(join(dir, 'comments', 'b.json'), 'utf8')).resolved).toBe(true);
    await writeComments(dir, [c({ id: 'b', num: 2, at: 2000 })]);
    expect(existsSync(join(dir, 'comments', 'a.json'))).toBe(false);
    expect((await readComments(dir)).map((x) => x.id)).toEqual(['b']);
  });

  it('reads nothing from a folder without comments, and skips broken files', async () => {
    const dir = tmp();
    expect(await readComments(dir)).toEqual([]);
    await writeComments(dir, [c()]);
    writeFileSync(join(dir, 'comments', 'broken.json'), '{not json');
    expect((await readComments(dir)).map((x) => x.id)).toEqual(['c1']);
  });

  it('merges two people commenting at the same time through git without a conflict', async () => {
    const origin = tmp();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const a = tmp();
    git(a, 'clone', '-q', origin, '.');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'start');
    git(a, 'push', '-q', 'origin', 'HEAD:main');
    const b = tmp();
    git(b, 'clone', '-q', origin, '.');

    await writeComments(join(a, '.designer'), [c({ id: 'from-a', num: 1, at: 100, text: 'From A' })]);
    git(a, 'add', '-A');
    git(a, 'commit', '-q', '-m', 'A comments');
    git(a, 'push', '-q', 'origin', 'HEAD:main');

    await writeComments(join(b, '.designer'), [c({ id: 'from-b', num: 1, at: 200, text: 'From B' })]);
    git(b, 'add', '-A');
    git(b, 'commit', '-q', '-m', 'B comments');
    git(b, 'pull', '-q', '--rebase', 'origin', 'main');

    const merged = await readComments(join(b, '.designer'));
    expect(merged.map((x) => [x.text, x.num])).toEqual([['From A', 1], ['From B', 2]]);
  });

  it('signs comments with the git user name', async () => {
    const dir = tmp();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Grace Designer');
    expect(await commentAuthor(dir)).toBe('Grace Designer');
  });

  it('describes open comments for Claude, with the frame they are on', () => {
    const list = [c({ replies: [{ author: 'Bo', text: 'Agreed', at: 2 }] }), c({ id: 'c2', num: 2, resolved: true, text: 'Old' })];
    const text = describeComments(list, (id) => (id === 'frame1' ? 'Pricing' : undefined));
    expect(text).toContain('#1 (id c1) on "Pricing" [layer frame1]: Ada: Tighten the spacing');
    expect(text).toContain('reply from Bo: Agreed');
    expect(text).not.toContain('Old');
    expect(describeComments(list, () => undefined, true)).toContain('[resolved]');
    expect(describeComments([], () => undefined)).toBe('There are no open comments on the canvas.');
  });
});
