// Visual review: before and after screenshots of what a change did to the components and pages
// on the canvas. When Claude is about to edit a file, Designer photographs the affected stories
// (and the pages on the canvas) in a headless Chromium-family browser it finds on the computer.
// When Claude's turn ends it photographs them again, compares the two pixel by pixel, and keeps
// the three images (before, after, highlighted difference) in <project>/.designer/reviews/.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import type { Browser, BrowserContext } from 'playwright-core';
import type { ServerMessage, StoryEntry, VisualReview, VisualShot } from '../shared/protocol.js';

const run = promisify(execFile);

export interface VisualTarget {
  /** Stable identity: the same story with the same args, or the same page URL. */
  key: string;
  label: string;
  kind: 'story' | 'page';
  storyId?: string;
  args?: Record<string, unknown>;
  url?: string;
  width: number;
  height: number;
}

export interface LiveUrls {
  storybook?: string | null;
  app?: string | null;
}

const MAX_TARGETS = 8;

// ----- What to photograph -----

/** Live components and pages on a saved canvas (the `.designer/canvas.json` the UI writes). */
export function canvasTargets(saved: unknown): VisualTarget[] {
  const nodes = ((saved as { doc?: { nodes?: Record<string, unknown> } } | null)?.doc?.nodes ?? {}) as Record<string, { type?: string; name?: string; w?: number; h?: number; code?: { kind?: string; storyId?: string; args?: Record<string, unknown>; url?: string } }>;
  const out: VisualTarget[] = [];
  for (const n of Object.values(nodes)) {
    if (n?.type !== 'code' || !n.code) continue;
    const width = Math.round(n.w ?? 0) || 800;
    const height = Math.round(n.h ?? 0) || 600;
    if (n.code.kind === 'component' && n.code.storyId) {
      const args = n.code.args ?? {};
      out.push({ key: storyKey(n.code.storyId, args), label: n.name || n.code.storyId, kind: 'story', storyId: n.code.storyId, args, width, height });
    } else if (n.code.kind === 'page' && n.code.url) {
      out.push({ key: `page:${n.code.url}`, label: n.name || n.code.url, kind: 'page', url: n.code.url, width, height });
    }
  }
  return dedupe(out);
}

export function storyKey(storyId: string, args: Record<string, unknown> = {}) {
  const keys = Object.keys(args).sort();
  return keys.length ? `story:${storyId}:${JSON.stringify(Object.fromEntries(keys.map((k) => [k, args[k]])))}` : `story:${storyId}`;
}

/** File name without folders or any extension: "src/Button/Button.module.css" -> "button". */
function stem(path: string) {
  return basename(path).split('.')[0].toLowerCase();
}

/** Is this story file about the changed file? Same folder, or the same name ("Button.tsx" and "Button.stories.tsx"). */
export function storyFileRelated(changed: string, storyFile: string) {
  const a = changed.replace(/\\/g, '/');
  const b = storyFile.replace(/\\/g, '/');
  return a === b || dirname(a) === dirname(b) || stem(a) === stem(b);
}

/** Stories that show the changed files, at most three per story file. */
export function storyTargetsForFiles(files: string[], stories: StoryEntry[]): VisualTarget[] {
  const out: VisualTarget[] = [];
  for (const entry of stories) {
    if (!files.some((f) => storyFileRelated(f, entry.file))) continue;
    for (const s of entry.stories.slice(0, 3)) {
      out.push({ key: storyKey(s.id), label: `${entry.title.split('/').pop()} / ${s.name}`, kind: 'story', storyId: s.id, args: {}, width: 800, height: 600 });
    }
  }
  return dedupe(out);
}

export function mergeTargets(...lists: VisualTarget[][]) {
  return dedupe(lists.flat()).slice(0, MAX_TARGETS);
}

function dedupe(list: VisualTarget[]) {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
}

/** Storybook's own URL for one story, with simple args in its `args=key:value;…` form. */
export function storyUrl(base: string, storyId: string, args: Record<string, unknown> = {}) {
  const simple = Object.entries(args)
    .filter(([k, v]) => /^[\w-]+$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[\w -]*$/.test(v))))
    .map(([k, v]) => `${k}:${typeof v === 'boolean' ? `!${v}` : v}`);
  return `${base.replace(/\/$/, '')}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story${simple.length ? `&args=${encodeURIComponent(simple.join(';'))}` : ''}`;
}

// ----- The camera -----

/** A Chromium-family browser on this computer: Chrome, Edge, Brave, Chromium, or DESIGNER_BROWSER. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync, home = homedir()): string | undefined {
  const mac = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
  const pf = env.PROGRAMFILES ?? 'C:\\Program Files';
  const pf86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const candidates =
    platform === 'darwin'
      ? [...mac.map((p) => `/Applications/${p}`), ...mac.map((p) => join(home, 'Applications', p))]
      : platform === 'win32'
        ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium', '/opt/pw-browsers/chromium'];
  return [env.DESIGNER_BROWSER, ...candidates].find((p): p is string => !!p && exists(p));
}

export interface Shooter {
  readonly available: boolean;
  readonly reason?: string;
  shoot(target: VisualTarget, urls: LiveUrls): Promise<Buffer>;
  close(): Promise<void>;
}

const STILL = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

/** Takes screenshots with a headless browser, started on first use and closed when idle. */
export class Camera implements Shooter {
  private browser?: Promise<Browser>;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly executablePath = findBrowser()) {}

  get available() {
    return !!this.executablePath;
  }
  get reason() {
    return this.executablePath ? undefined : 'No Chrome, Edge, Brave or Chromium was found on this computer, so Designer cannot take screenshots. Install one, or set DESIGNER_BROWSER to its path.';
  }

  private launch() {
    if (!this.executablePath) throw new Error(this.reason);
    if (!this.browser) {
      this.browser = import('playwright-core').then(({ chromium }) => chromium.launch({ executablePath: this.executablePath, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] }));
      this.browser.catch(() => (this.browser = undefined));
    }
    return this.browser;
  }

  async shoot(t: VisualTarget, urls: LiveUrls): Promise<Buffer> {
    clearTimeout(this.idle);
    const browser = await this.launch();
    let ctx: BrowserContext | undefined;
    try {
      if (t.kind === 'story') {
        if (!urls.storybook) throw new Error('Storybook is not running, so this component could not be photographed.');
        ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await page.goto(storyUrl(urls.storybook, t.storyId!, t.args), { waitUntil: 'load', timeout: 45000 });
        await page.addStyleTag({ content: `${STILL} body{background:transparent!important}` });
        await page.waitForSelector('#storybook-root > *, #root > *, .sb-show-errordisplay', { timeout: 15000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
        await page.waitForTimeout(200);
        const box = await page.evaluate(() => {
          const root = document.querySelector('#storybook-root') ?? document.querySelector('#root');
          if (!root || document.body.classList.contains('sb-show-errordisplay')) return null;
          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
          for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (el === root && root.children.length) continue;
            x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
          }
          return x2 > x1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
        });
        const pad = 8;
        const clip = box ? { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(box.width + pad * 2, 1600), height: Math.min(box.height + pad * 2, 1600) } : undefined;
        return await page.screenshot({ clip, fullPage: !clip, omitBackground: true, animations: 'disabled' });
      }
      if (!t.url) throw new Error('This page has no address.');
      ctx = await browser.newContext({ viewport: { width: clamp(t.width, 320, 1600), height: clamp(t.height, 240, 1200) }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(t.url, { waitUntil: 'load', timeout: 45000 });
      await page.addStyleTag({ content: STILL });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      return await page.screenshot({ animations: 'disabled' });
    } finally {
      await ctx?.close().catch(() => undefined);
      this.idle = setTimeout(() => void this.close(), 120000);
    }
  }

  async close() {
    clearTimeout(this.idle);
    const b = this.browser;
    this.browser = undefined;
    if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(v) || lo));
}

// ----- Comparing two screenshots -----

export interface PixelDiff {
  width: number;
  height: number;
  /** Pixels that differ by more than the threshold. */
  changed: number;
  /** changed / all pixels, 0..1. */
  ratio: number;
  sizeChanged: boolean;
  /** The after image, faded, with every changed pixel in red. */
  png: Buffer;
}

/**
 * Compares two PNGs pixel by pixel, on white (so transparent and white read the same). A pixel
 * counts as changed when any channel moves by more than `threshold` (0-255), which ignores the
 * faint anti-aliasing noise between two renders of the same thing.
 */
export function diffPng(beforePng: Buffer, afterPng: Buffer, threshold = 24): PixelDiff {
  const a = PNG.sync.read(beforePng);
  const b = PNG.sync.read(afterPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = new PNG({ width, height });
  const px = (img: PNG, x: number, y: number): [number, number, number] => {
    if (x >= img.width || y >= img.height) return [255, 255, 255];
    const i = (y * img.width + x) * 4;
    const al = img.data[i + 3] / 255;
    return [img.data[i] * al + 255 * (1 - al), img.data[i + 1] * al + 255 * (1 - al), img.data[i + 2] * al + 255 * (1 - al)];
  };
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = px(a, x, y);
      const q = px(b, x, y);
      const o = (y * width + x) * 4;
      if (Math.abs(p[0] - q[0]) > threshold || Math.abs(p[1] - q[1]) > threshold || Math.abs(p[2] - q[2]) > threshold) {
        changed++;
        out.data[o] = 255;
        out.data[o + 1] = 45;
        out.data[o + 2] = 85;
        out.data[o + 3] = 255;
      } else {
        const g = 0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2];
        const faded = 255 - (255 - g) * 0.25;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = faded;
        out.data[o + 3] = 255;
      }
    }
  }
  const total = width * height || 1;
  return { width, height, changed, ratio: changed / total, sizeChanged: a.width !== b.width || a.height !== b.height, png: PNG.sync.write(out) };
}

// ----- Reviews: one per change -----

export function reviewsDir(project: string) {
  return join(project, '.designer', 'reviews');
}

/** Screenshots are for review, not for the repo: keep them out of git without touching .gitignore. */
export async function excludeReviews(project: string) {
  try {
    const p = (await run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: project })).stdout.trim();
    const file = join(project, p.startsWith('/') ? relative(project, p) : p);
    const now = await readFile(file, 'utf8').catch(() => '');
    if (now.split('\n').some((l) => l.trim() === '.designer/reviews/')) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${now && !now.endsWith('\n') ? '\n' : ''}# Designer's before/after screenshots\n.designer/reviews/\n`);
  } catch {
    // Not a git repository: nothing to keep out.
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'shot';
}

export function summarize(r: VisualReview) {
  const changed = r.shots.filter((s) => (s.changed ?? 0) > 0).length;
  const shot = r.shots.filter((s) => s.after).length;
  if (!r.shots.length) return r.note ?? 'No components or pages to photograph.';
  if (!shot) return r.note ?? 'Screenshots could not be taken.';
  return changed ? `${changed} of ${shot} view${shot === 1 ? '' : 's'} changed` : `No visible change in ${shot} view${shot === 1 ? '' : 's'}`;
}

export interface ReviewDeps {
  project: () => string | undefined;
  shooter: Shooter;
  urls: () => LiveUrls | Promise<LiveUrls>;
  stories: (project: string) => Promise<StoryEntry[]>;
  canvas: (project: string) => Promise<unknown>;
  broadcast: (m: ServerMessage) => void;
  /** Time for a dev server to rebuild after the last edit (ms). */
  settleMs?: number;
}

interface Turn {
  id: string;
  project: string;
  title: string;
  files: Set<string>;
  before: Map<string, { target: VisualTarget; png?: Buffer; error?: string }>;
  pending: Promise<unknown>;
}

/**
 * Follows changes: `begin` when the designer asks for one, `beforeEdit` before each file edit
 * (it photographs whatever that edit may change, once), and `end` when the change is done.
 */
export class ReviewManager {
  private turn?: Turn;
  constructor(private readonly deps: ReviewDeps) {}

  begin(title: string) {
    const project = this.deps.project();
    this.turn = project ? { id: newId(), project, title: title.trim().split('\n')[0].slice(0, 120) || 'Design change', files: new Set(), before: new Map(), pending: Promise.resolve() } : undefined;
  }

  /** Photographs the views an edit to `absPath` can change, before it happens. */
  async beforeEdit(absPath: string) {
    if (!this.turn) this.begin('Design change');
    const turn = this.turn;
    if (!turn) return;
    const rel = relative(turn.project, absPath);
    if (rel.startsWith('..') || rel.startsWith('.designer')) return;
    turn.files.add(rel);
    const work = turn.pending.then(async () => {
      const targets = mergeTargets(canvasTargets(await this.deps.canvas(turn.project).catch(() => null)), storyTargetsForFiles([...turn.files], await this.deps.stories(turn.project).catch(() => [])));
      const fresh = targets.filter((t) => !turn.before.has(t.key)).slice(0, Math.max(0, MAX_TARGETS - turn.before.size));
      if (!fresh.length || !this.deps.shooter.available) {
        for (const t of fresh) turn.before.set(t.key, { target: t, error: this.deps.shooter.reason });
        return;
      }
      const urls = await this.deps.urls();
      for (const t of fresh) {
        try {
          turn.before.set(t.key, { target: t, png: await this.deps.shooter.shoot(t, urls) });
        } catch (e) {
          turn.before.set(t.key, { target: t, error: (e as Error).message });
        }
      }
    });
    turn.pending = work.catch(() => undefined);
    await work;
  }

  /** Records a change made outside Claude (a token edit, say) in one call. */
  async around<T>(title: string, files: string[], change: () => Promise<T>): Promise<T> {
    const project = this.deps.project();
    if (!project) return change();
    this.begin(title);
    for (const f of files) await this.beforeEdit(join(project, f)).catch(() => undefined);
    const out = await change();
    await this.end();
    return out;
  }

  /** Photographs the same views again, compares, and saves the review. Nothing is saved when no file changed. */
  async end(): Promise<VisualReview | undefined> {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn || !turn.files.size) return undefined;
    await turn.pending;
    const review: VisualReview = { id: turn.id, title: turn.title, createdAt: Date.now(), files: [...turn.files].sort(), shots: [], capturing: true };
    this.deps.broadcast({ type: 'review', review });
    await new Promise((r) => setTimeout(r, this.deps.settleMs ?? 900));
    const dir = join(reviewsDir(turn.project), turn.id);
    await mkdir(dir, { recursive: true });
    await excludeReviews(turn.project);
    const urls = await this.deps.urls();
        for (const b of turn.before.values()) review.shots.push(await this.capture(dir, b.target, b.png, b.error, urls));
    if (!turn.before.size) review.note = 'Nothing on the canvas or in Storybook shows these files, so there was nothing to photograph. Put the component on the canvas to get screenshots next time.';
    delete review.capturing;
    await writeFile(join(dir, 'review.json'), JSON.stringify(review, null, 1));
    this.deps.broadcast({ type: 'review', review });
    return review;
  }

  private async capture(dir: string, t: VisualTarget, before: Buffer | undefined, beforeError: string | undefined, urls: LiveUrls): Promise<VisualShot> {
    const name = `${slug(t.label)}-${hash(t.key)}`;
    const shot: VisualShot = { key: t.key, label: t.label, kind: t.kind, storyId: t.storyId, url: t.url };
    if (before) {
      await writeFile(join(dir, `${name}-before.png`), before);
      shot.before = `${name}-before.png`;
    }
    if (!this.deps.shooter.available) {
      shot.error = beforeError ?? this.deps.shooter.reason;
      return shot;
    }
    try {
      const after = await this.deps.shooter.shoot(t, urls);
      await writeFile(join(dir, `${name}-after.png`), after);
      shot.after = `${name}-after.png`;
      if (before) {
        const d = diffPng(before, after);
        shot.changed = d.ratio;
        shot.sizeChanged = d.sizeChanged;
        if (d.changed) {
          await writeFile(join(dir, `${name}-diff.png`), d.png);
          shot.diff = `${name}-diff.png`;
        }
      } else if (beforeError) shot.error = `No before picture: ${beforeError}`;
    } catch (e) {
      shot.error = (e as Error).message;
    }
    return shot;
  }

  /** Takes the after pictures again (say, the dev server was still rebuilding the first time). */
  async retake(id: string): Promise<VisualReview> {
    const project = this.deps.project();
    if (!project) throw new Error('Open a project first.');
    const review = await this.get(id);
    const dir = join(reviewsDir(project), id);
    const urls = await this.deps.urls();
    const shots: VisualShot[] = [];
    for (const s of review.shots) {
      const before = s.before ? await readFile(join(dir, s.before)).catch(() => undefined) : undefined;
      if (s.diff) await rm(join(dir, s.diff), { force: true });
      const t: VisualTarget = { key: s.key, label: s.label, kind: s.kind, storyId: s.storyId, url: s.url, args: parseArgs(s.key), width: 1280, height: 800 };
      shots.push(await this.capture(dir, t, before, undefined, urls));
    }
    review.shots = shots;
    await writeFile(join(dir, 'review.json'), JSON.stringify(review, null, 1));
    this.deps.broadcast({ type: 'review', review });
    return review;
  }

  async get(id: string): Promise<VisualReview> {
    const project = this.deps.project();
    if (!project || !/^[\w-]+$/.test(id)) throw new Error('No such review');
    return JSON.parse(await readFile(join(reviewsDir(project), id, 'review.json'), 'utf8')) as VisualReview;
  }

  /** Newest first. */
  async list(): Promise<VisualReview[]> {
    const project = this.deps.project();
    if (!project) return [];
    const ids = await readdir(reviewsDir(project)).catch(() => [] as string[]);
    const out: VisualReview[] = [];
    for (const id of ids) {
      const r = await this.get(id).catch(() => undefined);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(id: string, patch: Partial<VisualReview>) {
    const r = { ...(await this.get(id)), ...patch };
    await writeFile(join(reviewsDir(this.deps.project()!), id, 'review.json'), JSON.stringify(r, null, 1));
    this.deps.broadcast({ type: 'review', review: r });
    return r;
  }

  async remove(id: string) {
    const project = this.deps.project();
    if (!project || !/^[\w-]+$/.test(id)) throw new Error('No such review');
    await rm(join(reviewsDir(project), id), { recursive: true, force: true });
  }

  /** Absolute path of one image in a review, refusing anything outside it. */
  imagePath(id: string, file: string) {
    const project = this.deps.project();
    if (!project || !/^[\w-]+$/.test(id) || !/^[\w.-]+\.png$/.test(file)) throw new Error('No such image');
    return join(reviewsDir(project), id, file);
  }
}

function parseArgs(key: string): Record<string, unknown> {
  const m = /^story:[^:]+:(.+)$/.exec(key);
  try {
    return m ? (JSON.parse(m[1]) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}
