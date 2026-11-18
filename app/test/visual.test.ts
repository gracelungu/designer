import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Camera, canvasTargets, diffPng, excludeReviews, findBrowser, mergeTargets, ReviewManager, storyFileRelated, storyKey, storyTargetsForFiles, storyUrl, summarize, type Shooter, type VisualTarget } from '../src/server/visual';
import type { ServerMessage, StoryEntry } from '../src/shared/protocol';

function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = a;
    }
  return PNG.sync.write(p);
}

const stories: StoryEntry[] = [
  { file: 'src/components/Button/Button.stories.tsx', title: 'Components/Button', stories: [{ exportName: 'Primary', name: 'Primary', id: 'components-button--primary' }, { exportName: 'Ghost', name: 'Ghost', id: 'components-button--ghost' }] },
  { file: 'src/components/Card.stories.tsx', title: 'Card', stories: [{ exportName: 'Default', name: 'Default', id: 'card--default' }] },
];

describe('what to photograph', () => {
  it('reads live components and pages from a saved canvas', () => {
    const saved = {
      doc: {
        nodes: {
          a: { type: 'code', name: 'Button / Primary', w: 120, h: 40, code: { kind: 'component', storyId: 'components-button--primary', args: { label: 'Go' } } },
          b: { type: 'code', name: 'Home', w: 1280, h: 800, code: { kind: 'page', url: 'http://localhost:3000/' } },
          c: { type: 'rect', name: 'Box' },
          d: { type: 'code', name: 'dup', w: 1, h: 1, code: { kind: 'component', storyId: 'components-button--primary', args: { label: 'Go' } } },
        },
      },
    };
    const t = canvasTargets(saved);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ kind: 'story', storyId: 'components-button--primary', label: 'Button / Primary', args: { label: 'Go' } });
    expect(t[1]).toMatchObject({ kind: 'page', url: 'http://localhost:3000/', width: 1280, height: 800 });
    expect(canvasTargets(null)).toEqual([]);
  });

  it('matches story files to the files a change touches', () => {
    expect(storyFileRelated('src/components/Button/Button.module.css', 'src/components/Button/Button.stories.tsx')).toBe(true);
    expect(storyFileRelated('src/ui/card.tsx', 'src/components/Card.stories.tsx')).toBe(true);
    expect(storyFileRelated('src/theme/tokens.css', 'src/components/Card.stories.tsx')).toBe(false);
    const t = storyTargetsForFiles(['src/components/Button/Button.tsx'], stories);
    expect(t.map((x) => x.storyId)).toEqual(['components-button--primary', 'components-button--ghost']);
    expect(t[0].label).toBe('Button / Primary');
  });

  it('merges without duplicates and caps the number of views', () => {
    const many: VisualTarget[] = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `${i}`, kind: 'story', storyId: `s${i}`, width: 1, height: 1 }));
    expect(mergeTargets(many.slice(0, 3), many.slice(1, 4))).toHaveLength(4);
    expect(mergeTargets(many)).toHaveLength(8);
    expect(storyKey('a', { b: 1, a: 2 })).toBe('story:a:{"a":2,"b":1}');
  });

  it('builds Storybook story URLs with simple args only', () => {
    expect(storyUrl('http://localhost:6006/', 'button--primary')).toBe('http://localhost:6006/iframe.html?id=button--primary&viewMode=story');
    const u = storyUrl('http://localhost:6006', 'button--primary', { label: 'Buy now', disabled: true, size: 2, onClick: 'fn()', obj: {} });
    expect(decodeURIComponent(u.split('args=')[1])).toBe('label:Buy now;disabled:!true;size:2');
  });

  it('finds a Chrome-family browser per platform, or none', () => {
    expect(findBrowser({ DESIGNER_BROWSER: '/x/chrome' }, 'linux', (p) => p === '/x/chrome')).toBe('/x/chrome');
    expect(findBrowser({}, 'darwin', (p) => p === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')).toContain('Edge');
    expect(findBrowser({}, 'darwin', () => false)).toBeUndefined();
    expect(findBrowser({ PROGRAMFILES: 'C:\\PF' }, 'win32', (p) => p.startsWith('C:\\PF\\Google'))).toBe('C:\\PF\\Google\\Chrome\\Application\\chrome.exe');
  });
});

describe('diffPng', () => {
  it('finds no change in identical pictures and ignores faint noise', () => {
    const a = png(10, 10, () => [200, 50, 50, 255]);
    const b = png(10, 10, (x) => [x === 0 ? 210 : 200, 50, 50, 255]);
    const d = diffPng(a, b);
    expect(d.changed).toBe(0);
    expect(d.ratio).toBe(0);
  });

  it('counts changed pixels and marks them red', () => {
    const a = png(10, 10, () => [255, 255, 255, 255]);
    const b = png(10, 10, (x, y) => (x < 5 && y < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const d = diffPng(a, b);
    expect(d.changed).toBe(10);
    expect(d.ratio).toBeCloseTo(0.1);
    const out = PNG.sync.read(d.png);
    expect([...out.data.slice(0, 4)]).toEqual([255, 45, 85, 255]);
  });

  it('reads transparent as white and handles a size change', () => {
    const a = png(4, 4, () => [0, 0, 0, 0]);
    const b = png(4, 6, () => [255, 255, 255, 255]);
    const d = diffPng(a, b);
    expect(d.sizeChanged).toBe(true);
    expect(d.height).toBe(6);
    expect(d.changed).toBe(0);
  });
});

/** A camera that "photographs" a file: its color is the picture. */
class FileShooter implements Shooter {
  available = true;
  shots = 0;
  constructor(private readonly file: string) {}
  async shoot() {
    this.shots++;
    const color = readFileSync(this.file, 'utf8').trim();
    const v = color === 'red' ? [255, 0, 0, 255] : [0, 0, 255, 255];
    return png(8, 8, () => v as [number, number, number, number]);
  }
  async close() {}
}

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-visual-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'Button.css'), 'red\n');
  return dir;
}

describe('ReviewManager', () => {
  it('photographs before an edit and after the turn, and saves a review with a diff', async () => {
    const dir = project();
    const shooter = new FileShooter(join(dir, 'src', 'Button.css'));
    const msgs: ServerMessage[] = [];
    const m = new ReviewManager({
      project: () => dir,
      shooter,
      urls: () => ({ storybook: 'http://sb' }),
      stories: async () => [{ file: 'src/Button.stories.tsx', title: 'Button', stories: [{ exportName: 'Primary', name: 'Primary', id: 'button--primary' }] }],
      canvas: async () => null,
      broadcast: (x) => msgs.push(x),
      settleMs: 0,
    });
    m.begin('Make the button blue\nplease');
    await m.beforeEdit(join(dir, 'src', 'Button.css'));
    await m.beforeEdit(join(dir, 'src', 'Button.css'));
    expect(shooter.shots).toBe(1);
    writeFileSync(join(dir, 'src', 'Button.css'), 'blue\n');
    const r = (await m.end())!;
    expect(r.title).toBe('Make the button blue');
    expect(r.files).toEqual(['src/Button.css']);
    expect(r.shots).toHaveLength(1);
    expect(r.shots[0]).toMatchObject({ label: 'Button / Primary', changed: 1 });
    expect(r.shots[0].diff).toMatch(/-diff\.png$/);
    expect(existsSync(m.imagePath(r.id, r.shots[0].before!))).toBe(true);
    expect(summarize(r)).toBe('1 of 1 view changed');
    expect(msgs.filter((x) => x.type === 'review')).toHaveLength(2);
    expect((await m.list())[0].id).toBe(r.id);
    // Screenshots stay out of the repository.
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.designer/reviews/');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).not.toContain('.designer');
    // Retake reuses the before picture.
    writeFileSync(join(dir, 'src', 'Button.css'), 'red\n');
    const again = await m.retake(r.id);
    expect(again.shots[0].changed).toBe(0);
    expect(again.shots[0].diff).toBeUndefined();
    await m.update(r.id, { sentIn: 'https://x/pull/1' });
    expect((await m.get(r.id)).sentIn).toBe('https://x/pull/1');
    await m.remove(r.id);
    expect(await m.list()).toEqual([]);
  });

  it('saves nothing when the turn changed no file, and notes when nothing could be photographed', async () => {
    const dir = project();
    const m = new ReviewManager({ project: () => dir, shooter: new FileShooter(join(dir, 'src', 'Button.css')), urls: () => ({}), stories: async () => [], canvas: async () => null, broadcast: () => undefined, settleMs: 0 });
    m.begin('just a question');
    expect(await m.end()).toBeUndefined();
    m.begin('edit a readme');
    await m.beforeEdit(join(dir, 'README.md'));
    const r = (await m.end())!;
    expect(r.shots).toEqual([]);
    expect(r.note).toMatch(/Nothing on the canvas/);
  });

  it('records why when there is no browser', async () => {
    const dir = project();
    const none: Shooter = { available: false, reason: 'No browser', shoot: async () => Buffer.alloc(0), close: async () => undefined };
    const m = new ReviewManager({ project: () => dir, shooter: none, urls: () => ({}), stories: async () => [{ file: 'src/Button.stories.tsx', title: 'Button', stories: [{ exportName: 'A', name: 'A', id: 'button--a' }] }], canvas: async () => null, broadcast: () => undefined, settleMs: 0 });
    await m.beforeEdit(join(dir, 'src', 'Button.css'));
    const r = (await m.end())!;
    expect(r.shots[0].error).toBe('No browser');
    expect(summarize(r)).toBe('Screenshots could not be taken.');
  });

  it('refuses image paths outside a review', () => {
    const m = new ReviewManager({ project: () => '/p', shooter: new FileShooter('/x'), urls: () => ({}), stories: async () => [], canvas: async () => null, broadcast: () => undefined });
    expect(() => m.imagePath('../x', 'a.png')).toThrow();
    expect(() => m.imagePath('abc', '../../etc/passwd')).toThrow();
    expect(m.imagePath('abc', 'a-before.png')).toBe('/p/.designer/reviews/abc/a-before.png');
  });

  it('adds the exclude line only once', async () => {
    const dir = project();
    await excludeReviews(dir);
    await excludeReviews(dir);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').match(/\.designer\/reviews\//g)).toHaveLength(1);
  });
});

// A real headless browser against a stand-in Storybook: the component's color comes from a file.
const browser = findBrowser();
describe.skipIf(!browser)('Camera with a real browser', () => {
  let server: Server;
  let base = '';
  const state = { color: '#ff0000', width: 120 };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/iframe.html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body style="padding:16px;margin:0"><div id="storybook-root"><button style="width:${state.width}px;height:40px;border:0;background:${state.color}">Go</button></div></body></html>`);
      } else if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body style="margin:0;background:${state.color}"><h1>Home</h1></body></html>`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => server.close());

  it('crops a story to the component and sees a color change', async () => {
    const cam = new Camera(browser);
    const t: VisualTarget = { key: 's', label: 'Button', kind: 'story', storyId: 'button--primary', width: 0, height: 0 };
    const before = await cam.shoot(t, { storybook: base });
    const size = PNG.sync.read(before);
    // 120x40 plus 8px around, at 2x.
    expect(size.width).toBe((120 + 16) * 2);
    expect(size.height).toBe((40 + 16) * 2);
    state.color = '#0000ff';
    state.width = 160;
    const after = await cam.shoot(t, { storybook: base });
    const d = diffPng(before, after);
    expect(d.sizeChanged).toBe(true);
    expect(d.ratio).toBeGreaterThan(0.5);
    const page = await cam.shoot({ key: 'p', label: 'Home', kind: 'page', url: `${base}/page`, width: 400, height: 300 }, {});
    expect(PNG.sync.read(page).width).toBe(400);
    await expect(cam.shoot(t, {})).rejects.toThrow(/Storybook is not running/);
    await cam.close();
  }, 60000);
});
