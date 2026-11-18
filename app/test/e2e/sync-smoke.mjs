#!/usr/bin/env node
/* global process, setTimeout, console, window */
// Smoke test of the whole app: the built server and UI in Chromium, a real git project with a
// stand-in Storybook, and a fake `claude` on PATH (no Claude credits needed).
// It checks both directions of the design <-> code sync like a designer would use them:
//   1. a design layer linked to a component is recoloured on the canvas -> Send to code ->
//      the fake Claude Code edits the CSS -> the diff is reviewed -> Keep
//   2. a teammate pushes a new colour -> Get latest -> the linked design layer follows the code
// Run: npm run build && npm run test:smoke:sync   (SHOTS=<dir> saves screenshots)
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const fake = join(here, '..', 'fixtures', 'fake-claude.mjs');
const shots = process.env.SHOTS;
const tmp = (p = 'designer-smoke-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A project: a Button with its CSS and a story, plus a tiny Storybook stand-in ----
const STORYBOOK = String.raw`
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const css = () => readFileSync(new URL('./src/Button.css', import.meta.url), 'utf8');
const s = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/index.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 5, entries: { 'ui-button--primary': { id: 'ui-button--primary', title: 'UI/Button', name: 'Primary', importPath: './src/Button.stories.tsx', type: 'story' } } }));
  if (u.pathname === '/iframe.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><style>' + css() + '</style></head><body><div id="storybook-root"><button class="button">Buy now</button></div></body></html>');
  res.writeHead(404).end();
});
s.listen(0, '127.0.0.1', () => console.log('Storybook started: Local: http://127.0.0.1:' + s.address().port + '/'));
`;
const BUTTON_CSS = '.button {\n  display: inline-flex;\n  gap: 8px;\n  padding: 10px 16px;\n  border: 0;\n  border-radius: 6px;\n  background: #111111;\n  color: #ffffff;\n  font: 600 14px sans-serif;\n}\n';

const origin = tmp();
mkdirSync(join(origin, 'src'));
writeFileSync(join(origin, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts: { storybook: 'node storybook.mjs' } }, null, 2));
writeFileSync(join(origin, 'storybook.mjs'), STORYBOOK);
writeFileSync(join(origin, 'src', 'Button.css'), BUTTON_CSS);
writeFileSync(join(origin, 'src', 'Button.stories.tsx'), "import './Button.css';\nexport default { title: 'UI/Button' };\nexport const Primary = {};\n");
writeFileSync(join(origin, '.gitignore'), '.designer/\n');
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Teammate', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Teammate', GIT_COMMITTER_EMAIL: 't@example.com' });
git(origin, 'init', '-q', '-b', 'main');
git(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
git(origin, 'add', '-A');
git(origin, 'commit', '-qm', 'Button');
const mine = tmp();
git(mine, 'clone', '-q', origin, '.');

// ---- Designer, with the fake claude on PATH ----
chmodSync(fake, 0o755);
const bin = tmp();
symlinkSync(fake, join(bin, 'claude'));
const port = 4900 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [join(app, 'dist', 'server', 'cli.mjs'), '--project', mine, '--port', String(port), '--no-open'], {
  cwd: app,
  env: {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: tmp(),
    FAKE_CLAUDE_EDITS: JSON.stringify([{ file: 'src/Button.css', old: 'background: #111111', new: 'background: #2563eb' }]),
    FAKE_CLAUDE_SUMMARY: 'src/Button.css: the button background is now #2563eb.',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const url = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 100 && !serverLog.includes('running at'); i++) await sleep(100);

const results = [];
const errors = [];
let page;
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, String(e.message).split('\n')[0]]);
  }
  if (shots && page) await page.screenshot({ path: join(shots, `${String(results.length).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) }).catch(() => undefined);
}
const until = async (fn, what, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};
const designFill = () =>
  page.evaluate(() => {
    const { host } = window.__designer;
    const s = host.editor.store;
    const n = s.allIds().map((id) => s.get(id)).find((x) => x.name === 'Button design');
    return n?.fills?.[0]?.color;
  });

const browser = await chromium.launch();
try {
  if (shots) mkdirSync(shots, { recursive: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
  page.on('pageerror', (e) => errors.push(e.message));

  await check('app loads with the project and Claude Code', async () => {
    await page.goto(url);
    await page.waitForSelector('.topbar', { timeout: 15000 });
    await until(() => page.locator('.topbar .chip b').textContent().then((t) => t === mine.split('/').pop()), 'project chip');
    await until(() => page.evaluate(() => !!window.__designer), 'canvas');
  });

  await check('a design layer linked to the coded Button sits beside the live component', async () => {
    await page.evaluate(async () => {
      const { host } = window.__designer;
      await host.apply({
        kind: 'add-nodes',
        nodes: [
          {
            type: 'frame',
            name: 'Button design',
            x: 80,
            y: 80,
            fill: '#111111',
            radius: 6,
            layout: { mode: 'horizontal', gap: 8, padding: [10, 16, 10, 16] },
            children: [{ type: 'text', name: 'Label', text: { content: 'Buy now', fontSize: 14, fontWeight: 600, color: '#FFFFFF' } }],
            codeLink: { storyId: 'ui-button--primary', file: 'src/Button.stories.tsx', exportName: 'Primary' },
          },
        ],
      });
      await host.placeStory('ui-button--primary', { title: 'Button / Primary', file: 'src/Button.stories.tsx', nextToSelection: true });
    });
    // The link gets a baseline and a measure of how the code renders (Storybook starts for it).
    await until(
      () => page.evaluate(() => { const s = window.__designer.host.editor.store; const n = s.allIds().map((id) => s.get(id)).find((x) => x.name === 'Button design'); return n?.sync?.code?.fill === '#111111'; }),
      'the code measure',
      60000,
    );
    if (await page.locator('[data-testid=sync-bar]').count()) throw new Error('nothing changed yet, but the sync bar shows');
  });

  await check('recolouring the design shows it as an edit not in code yet', async () => {
    await page.evaluate(async () => {
      const { host } = window.__designer;
      const s = host.editor.store;
      const n = s.allIds().map((id) => s.get(id)).find((x) => x.name === 'Button design');
      await host.apply({ kind: 'update-nodes', updates: [{ id: n.id, fill: '#2563EB' }] });
    });
    await page.locator('[data-testid=sync-bar]').waitFor({ timeout: 5000 });
    const t = await page.locator('[data-testid=sync-bar]').textContent();
    if (!/1 layer has edits/.test(t)) throw new Error(`bar says: ${t}`);
    await page.locator('[data-testid=sync-bar]').click();
    await page.locator('[data-testid=sync-pending]').waitFor();
    const card = await page.locator('[data-testid=sync-pending]').textContent();
    if (!/Fill.*#111111.*#2563EB/.test(card)) throw new Error(`card says: ${card}`);
  });

  await check('Send to code runs Claude Code and shows the diff for review', async () => {
    await page.locator('[data-testid=sync-pending] button', { hasText: 'Send to code' }).click();
    await page.locator('[data-testid=sync-job-review]').waitFor({ timeout: 20000 });
    const txt = await page.locator('[data-testid=sync-job-review]').textContent();
    if (!txt.includes('src/Button.css') || !txt.includes('background: #2563eb') || !txt.includes('the button background is now #2563eb')) throw new Error(`review card: ${txt.slice(0, 300)}`);
  });

  await check('Keep keeps the code change and clears the pending edit', async () => {
    await page.locator('[data-testid=sync-job-review] button', { hasText: 'Keep' }).click();
    await until(() => page.locator('[data-testid=sync-job-kept]').count(), 'kept');
    if (!readFileSync(join(mine, 'src', 'Button.css'), 'utf8').includes('#2563eb')) throw new Error('Button.css was not changed');
    if (await page.locator('[data-testid=sync-pending]').count()) throw new Error('edit still pending');
    // Save it as a version, as a designer would before others change the same code.
    git(mine, 'commit', '-qam', 'Blue button (from Designer)');
    git(mine, 'push', '-q', 'origin', 'main');
    // Once Storybook shows the new code, it is remembered as the code's look.
    await until(
      () => page.evaluate(() => { const s = window.__designer.host.editor.store; const n = s.allIds().map((id) => s.get(id)).find((x) => x.name === 'Button design'); return n?.sync?.code?.fill === '#2563EB'; }),
      'the new code measure',
    );
  });

  await check('a teammate changes the code; Get latest updates the linked design', async () => {
    const other = tmp();
    git(other, 'clone', '-q', origin, '.');
    git(other, 'checkout', '-q', '.');
    writeFileSync(join(other, 'src', 'Button.css'), readFileSync(join(other, 'src', 'Button.css'), 'utf8').replace('#2563eb', '#16a34a').replace('border-radius: 6px', 'border-radius: 10px'));
    git(other, 'commit', '-qam', 'Green, rounder button');
    git(other, 'push', '-q', 'origin', 'main');
    await page.locator('.topbar button', { hasText: 'Get latest' }).click();
    await until(() => designFill().then((c) => c === '#16A34A'), 'the design to turn green', 30000);
    const radius = await page.evaluate(() => { const s = window.__designer.host.editor.store; return s.allIds().map((id) => s.get(id)).find((x) => x.name === 'Button design').radius; });
    if (radius !== 10) throw new Error(`radius is ${radius}`);
    await page.locator('[data-testid=sync-update]').first().waitFor();
    const u = await page.locator('[data-testid=sync-update]').first().textContent();
    if (!/Fill/.test(u) || !/Corner radius/.test(u)) throw new Error(`update card: ${u}`);
    if (await page.locator('[data-testid=sync-pending]').count()) throw new Error('code update shows as a canvas edit');
  });

  await check('no errors in the page', async () => {
    if (errors.length) throw new Error(errors.join(' | '));
  });
} finally {
  await browser.close();
  server.kill();
}

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) {
  console.log(serverLog.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
process.exit(0);
