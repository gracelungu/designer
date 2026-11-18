import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchName, compareUrl, defaultBranch, friendlyGitError, parseGitHubRemote, prBody, sendForReview, SCREENSHOTS_BRANCH, webUrl } from '../src/server/share';
import type { ShareStep, VisualReview } from '../src/shared/protocol';
import { fakeGh, git, githubLikeProject } from './fixtures/repo';

function reviewWithShots(dir: string): VisualReview {
  const rdir = join(dir, '.designer', 'reviews', 'r1');
  mkdirSync(rdir, { recursive: true });
  for (const f of ['b-before.png', 'b-after.png', 'b-diff.png', 'c-before.png', 'c-after.png']) writeFileSync(join(rdir, f), `png ${f}`);
  return {
    id: 'r1',
    title: 'Make the button blue',
    createdAt: 1,
    files: ['src/Button.css'],
    shots: [
      { key: 'story:button--primary', label: 'Button / Primary', kind: 'story', before: 'b-before.png', after: 'b-after.png', diff: 'b-diff.png', changed: 0.42 },
      { key: 'story:card--default', label: 'Card', kind: 'story', before: 'c-before.png', after: 'c-after.png', changed: 0 },
    ],
  };
}

describe('share helpers', () => {
  it('reads GitHub remotes in every form', () => {
    expect(parseGitHubRemote('git@github.com:acme/site.git')).toEqual({ owner: 'acme', repo: 'site' });
    expect(parseGitHubRemote('https://github.com/acme/site')).toEqual({ owner: 'acme', repo: 'site' });
    expect(parseGitHubRemote('https://x-token@github.com/acme/site.git/')).toEqual({ owner: 'acme', repo: 'site' });
    expect(parseGitHubRemote('https://dev.azure.com/acme/p/_git/site')).toBeUndefined();
  });

  it('turns remotes into web addresses without credentials', () => {
    expect(webUrl('git@github.com:acme/site.git')).toBe('https://github.com/acme/site');
    expect(webUrl('https://user:secret@github.com/acme/site.git')).toBe('https://github.com/acme/site');
    expect(webUrl('ssh://git@gitlab.com/acme/site.git')).toBe('https://gitlab.com/acme/site');
  });

  it('opens a prefilled pull request page on GitHub, GitLab and Azure DevOps', () => {
    const gh = compareUrl('git@github.com:acme/site.git', 'main', 'design/x', 'Blue button', 'Body');
    expect(gh).toBe('https://github.com/acme/site/compare/main...design%2Fx?expand=1&title=Blue%20button&body=Body');
    expect(compareUrl('https://gitlab.com/acme/site.git', 'main', 'd', 't', 'b')).toContain('/-/merge_requests/new?');
    expect(compareUrl('https://dev.azure.com/acme/p/_git/site', 'main', 'd', 't', 'b')).toContain('/pullrequestcreate?sourceRef=d&targetRef=main');
    expect(compareUrl('git@github.com:a/b.git', 'main', 'd', 't', 'x'.repeat(10000)).length).toBeLessThan(7000);
  });

  it('explains git failures in plain words', () => {
    expect(friendlyGitError({ stderr: 'fatal: could not read Username for https://github.com' })).toMatch(/did not accept your sign-in/);
    expect(friendlyGitError({ stderr: '*** Please tell me who you are.' })).toMatch(/does not know your name/);
    expect(friendlyGitError({ stderr: 'CONFLICT (content): Merge conflict in a.css' })).toMatch(/same lines/);
    expect(friendlyGitError({ stderr: 'fatal: unable to access: Could not resolve host: github.com' })).toMatch(/internet/);
    expect(friendlyGitError(new Error('something odd'))).toBe('something odd');
  });

  it('names branches after the change', () => {
    expect(branchName('Denser pricing cards!', 'ab12')).toBe('design/denser-pricing-cards-ab12');
    expect(branchName('', 'ab12')).toBe('design/update-ab12');
  });

  it('writes a pull request body with before and after pictures', () => {
    const r = reviewWithShots(realpathSync(mkdtempSync(join(tmpdir(), 'designer-body-'))));
    const body = prBody({ description: 'Please check the hover', reviews: [r], image: (id, f) => `https://img/${id}/${f}`, files: ['src/Button.css'] });
    expect(body).toContain('Please check the hover');
    expect(body).toContain('## What changed visually');
    expect(body).toContain('### Make the button blue');
    expect(body).toContain('<img src="https://img/r1/b-before.png"');
    expect(body).toContain('<img src="https://img/r1/b-after.png"');
    expect(body).toContain('42% of pixels changed');
    expect(body).toContain('[highlight](https://img/r1/b-diff.png)');
    expect(body).toContain('No visible change: Card');
    expect(body).toContain('- `src/Button.css`');
  });
});

describe('sendForReview', () => {
  it('saves, branches, uploads screenshots, pushes and opens a pull request in one go', async () => {
    const { root, bare, dir } = githubLikeProject();
    const gh = fakeGh(root);
    writeFileSync(join(dir, 'src', 'Button.css'), '.btn { color: blue; }\n');
    const review = reviewWithShots(dir);
    const steps: [ShareStep, string][] = [];
    const r = await sendForReview(dir, { title: 'Make the button blue', description: 'Check hover too', reviews: [review], reviewDir: (id) => join(dir, '.designer', 'reviews', id), onStep: (s, st) => steps.push([s, st]), gh: gh.bin });
    expect(r).toMatchObject({ ok: true, url: 'https://github.com/acme/site/pull/12' });
    expect(r.branch).toMatch(/^design\/make-the-button-blue-/);
    // Main was not touched; the branch has the change, and nothing from .designer/reviews.
    expect(git(bare, 'log', '--format=%s', 'main')).toBe('First');
    expect(git(bare, 'log', '--format=%s', r.branch!)).toBe('Make the button blue\nFirst');
    expect(git(bare, 'ls-tree', '-r', '--name-only', r.branch!)).not.toContain('.designer');
    // The screenshots are on their own branch.
    const shots = git(bare, 'ls-tree', '-r', '--name-only', SCREENSHOTS_BRANCH).split('\n');
    expect(shots).toContain(`reviews/${r.branch}/r1/b-before.png`);
    expect(shots).toHaveLength(5);
    const shotCommit = git(bare, 'rev-parse', SCREENSHOTS_BRANCH);
    // The pull request shows them, pinned to that commit.
    const call = gh.calls()[0];
    expect(call.args.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', r.branch!]);
    expect(call.body).toContain(`https://github.com/acme/site/blob/${shotCommit}/reviews/design/`);
    expect(call.body).toContain('Check hover too');
    expect(steps.map((s) => s.join(':'))).toEqual(['branch:running', 'branch:done', 'save:running', 'save:done', 'screenshots:running', 'screenshots:done', 'push:running', 'push:done', 'pr:running', 'pr:done']);
    // The designer is left on the review branch with nothing unsaved.
    expect(git(dir, 'status', '--porcelain')).toBe('');

    // A second send adds to the screenshots branch instead of replacing it.
    writeFileSync(join(dir, 'src', 'Button.css'), '.btn { color: green; }\n');
    const again = await sendForReview(dir, { title: 'Green', reviews: [{ ...review, id: 'r1' }], reviewDir: (id) => join(dir, '.designer', 'reviews', id), gh: gh.bin });
    expect(again.ok).toBe(true);
    expect(git(bare, 'rev-list', '--count', SCREENSHOTS_BRANCH)).toBe('2');
  });

  it('comments on the open pull request when there already is one', async () => {
    const { root, dir } = githubLikeProject();
    const gh = fakeGh(root, 'exists');
    writeFileSync(join(dir, 'src', 'Button.css'), 'x\n');
    const r = await sendForReview(dir, { title: 'x', reviews: [], reviewDir: () => '', gh: gh.bin });
    expect(r).toMatchObject({ ok: true, url: 'https://github.com/acme/site/pull/7' });
    expect(r.message).toMatch(/Updated the open review/);
    expect(gh.calls().map((c) => c.args.slice(0, 2).join(' '))).toEqual(['pr create', 'pr comment']);
  });

  it('falls back to a prefilled page in the browser when gh is missing', async () => {
    const { dir } = githubLikeProject();
    writeFileSync(join(dir, 'src', 'Button.css'), 'x\n');
    const r = await sendForReview(dir, { title: 'No gh here', reviews: [], reviewDir: () => '', gh: '/nonexistent/gh' });
    expect(r.ok).toBe(true);
    expect(r.needsConfirm).toBe(true);
    expect(r.url).toMatch(/^https:\/\/github\.com\/acme\/site\/compare\/main\.\.\.design%2Fno-gh-here-\w+\?expand=1&title=No%20gh%20here/);
  });

  it('says so when there is nothing to send or nowhere to send it', async () => {
    const { dir } = githubLikeProject();
    expect(await sendForReview(dir, { title: 'x', reviews: [], reviewDir: () => '' })).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing new/) });
    git(dir, 'remote', 'remove', 'origin');
    expect((await sendForReview(dir, { title: 'x', reviews: [], reviewDir: () => '' })).message).toMatch(/no remote/);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'designer-plain-')));
    expect((await sendForReview(plain, { title: 'x', reviews: [], reviewDir: () => '' })).message).toMatch(/not a git repository/);
  });

  it('keeps using the branch the designer is already on', async () => {
    const { root, bare, dir } = githubLikeProject();
    git(dir, 'switch', '-q', '-c', 'design/dark-mode');
    writeFileSync(join(dir, 'src', 'Button.css'), 'dark\n');
    const r = await sendForReview(dir, { title: 'Dark', reviews: [], reviewDir: () => '', gh: fakeGh(root).bin });
    expect(r.branch).toBe('design/dark-mode');
    expect(git(bare, 'log', '--format=%s', 'design/dark-mode')).toBe('Dark\nFirst');
  });

  it('finds the default branch even without origin/HEAD', async () => {
    const { dir } = githubLikeProject();
    git(dir, 'remote', 'set-head', 'origin', '-d');
    expect(await defaultBranch(dir)).toBe('main');
  });
});
