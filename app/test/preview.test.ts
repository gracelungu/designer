import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPreview, parseAzureRemote, previewLink, slugify, writePreview } from '../src/server/preview';
import type { CanvasComment, PreviewFrame } from '../src/shared/protocol';

const comment = (over: Partial<CanvasComment> = {}): CanvasComment => ({ id: 'c1', num: 1, x: 0, y: 0, nodeId: 'f1', dx: 0, dy: 0, author: 'Ada', text: 'Make it bigger', at: 1, resolved: false, replies: [], ...over });
const frame = (over: Partial<PreviewFrame> = {}): PreviewFrame => ({ id: 'f1', name: 'Pricing page', w: 400, h: 200, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"></svg>', css: 'width: 400px;', components: [{ name: 'Button', storyId: 'button--primary', file: 'src/Button.tsx' }], pins: [{ id: 'c1', x: 100, y: 50 }], ...over });

describe('preview links', () => {
  it('reads Azure DevOps remotes in all their forms', () => {
    expect(parseAzureRemote('https://dev.azure.com/contoso/Web%20App/_git/web')).toEqual({ org: 'contoso', project: 'Web App', repo: 'web' });
    expect(parseAzureRemote('https://contoso@dev.azure.com/contoso/Shop/_git/web')).toEqual({ org: 'contoso', project: 'Shop', repo: 'web' });
    expect(parseAzureRemote('git@ssh.dev.azure.com:v3/contoso/Shop/web')).toEqual({ org: 'contoso', project: 'Shop', repo: 'web' });
    expect(parseAzureRemote('https://contoso.visualstudio.com/DefaultCollection/Shop/_git/web')).toEqual({ org: 'contoso', project: 'Shop', repo: 'web' });
    expect(parseAzureRemote('https://github.com/a/b.git')).toBeUndefined();
  });
  it('points at the preview folder on the branch', () => {
    expect(previewLink('git@github.com:grace/designer.git', 'design/x')).toBe('https://github.com/grace/designer/tree/design/x/.designer/preview');
    expect(previewLink('https://github.com/grace/designer', 'main')).toBe('https://github.com/grace/designer/tree/main/.designer/preview');
    expect(previewLink('https://dev.azure.com/contoso/Shop/_git/web', 'design/x')).toBe('https://dev.azure.com/contoso/Shop/_git/web?path=/.designer/preview/README.md&version=GBdesign%2Fx');
    expect(previewLink('https://gitlab.com/a/b.git', 'main')).toBeUndefined();
    expect(previewLink(undefined, 'main')).toBeUndefined();
  });
  it('makes distinct file names', () => {
    const taken = new Set<string>();
    expect([slugify('Pricing Page', taken), slugify('Pricing page', taken), slugify('***', taken)]).toEqual(['pricing-page', 'pricing-page-2', 'frame']);
  });
});

describe('buildPreview', () => {
  it('writes a README with each frame, its components and its comments', () => {
    const { files } = buildPreview({ title: 'Shop design', frames: [frame()], comments: [comment({ replies: [{ author: 'Bo', text: 'Done', at: 2 }] })], generatedAt: new Date('2026-11-18T12:00:00Z') });
    expect(Object.keys(files).sort()).toEqual(['README.md', 'index.html', 'pricing-page.svg']);
    const md = files['README.md'];
    expect(md).toContain('# Shop design');
    expect(md).toContain('![Pricing page](./pricing-page.svg)');
    expect(md).toContain('[`src/Button.tsx`](../../src/Button.tsx)');
    expect(md).toContain('**#1** Ada: Make it bigger');
    expect(md).toContain('  - Bo: Done');
    expect(md).toContain('2026-11-18 12:00 UTC');
  });

  it('places comment pins on the frame in the HTML page', () => {
    const { files } = buildPreview({ title: 'T', frames: [frame()], comments: [comment()] });
    const html = files['index.html'];
    expect(html).toContain('left:25.00%;top:25.00%');
    expect(html).toContain('href="#c-c1"');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('<meta name="viewport"');
  });

  it('escapes what people typed, in HTML and Markdown', () => {
    const evil = comment({ text: '<img src=x onerror=alert(1)> [link](javascript:alert(1))', author: '<b>Eve</b>' });
    const { files } = buildPreview({ title: '<script>alert(1)</script>', frames: [frame({ name: '<i>x</i>' })], comments: [evil] });
    expect(files['index.html']).not.toContain('<script>alert(1)');
    expect(files['index.html']).not.toContain('<img src=x');
    expect(files['index.html']).not.toContain('<b>Eve</b>');
    expect(files['README.md']).not.toContain('<img src=x');
    expect(files['README.md']).not.toContain('](javascript:');
  });

  it('lists comments that are not on any frame separately, leaving resolved ones out', () => {
    const { files } = buildPreview({ title: 'T', frames: [frame({ pins: [] })], comments: [comment({ id: 'loose', text: 'General note' }), comment({ id: 'old', text: 'Old note', resolved: true })] });
    expect(files['README.md']).toContain('## Other comments');
    expect(files['README.md']).toContain('General note');
    expect(files['README.md']).not.toContain('Old note');
  });

  it('says so when the canvas is empty', () => {
    expect(buildPreview({ title: 'T', frames: [], comments: [] }).files['README.md']).toContain('no frames yet');
  });
});

describe('writePreview', () => {
  it('replaces the folder, removing frames that are gone', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-preview-')));
    await writePreview(dir, { 'README.md': 'a', 'old.svg': '<svg/>' });
    const r = await writePreview(dir, { 'README.md': 'b', 'new.svg': '<svg/>' });
    expect(r.files).toEqual(['.designer/preview/README.md', '.designer/preview/new.svg']);
    expect(existsSync(join(dir, 'preview', 'old.svg'))).toBe(false);
    expect(readFileSync(join(dir, 'preview', 'README.md'), 'utf8')).toBe('b');
    writeFileSync(join(dir, 'preview', 'x'), '');
  });
});
