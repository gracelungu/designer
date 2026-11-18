// End-to-end smoke test of the built app: a real server, the real UI in a real browser, a stand-in
// Claude Code that edits a component, a stand-in Storybook that renders it, and a GitHub-like remote.
// It walks the designer's path: ask for a change → see before/after → send for review → versions.
// Needs `npm run build` first (it serves dist/web) and a Chrome-family browser.
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { findBrowser } from '../src/server/visual';
import { startServer } from '../src/server/index';
import { fakeGh, git, githubLikeProject } from './fixtures/repo';

const web = join(__dirname, '..', 'dist', 'web');
const browserPath = findBrowser();
const shotsDir = process.env.SMOKE_SHOTS;

describe.skipIf(!browserPath || !existsSync(join(web, 'index.html')))('smoke: visual review, send for review, versions', () => {
  let storybook: Server;
  let server: Awaited<ReturnType<typeof startServer>>;
  let browser: Browser;
  let page: Page;
  let repo: ReturnType<typeof githubLikeProject>;
  let gh: ReturnType<typeof fakeGh>;

  beforeAll(async () => {
    repo = githubLikeProject();
    const { dir } = repo;
    // A stand-in Storybook whose button takes its color from src/Button.css.
    storybook = createServer((req, res) => {
      if (req.url === '/index.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ v: 5, entries: { 'button--primary': { id: 'button--primary', importPath: './src/Button.stories.tsx' } } }));
      }
      if (req.url?.startsWith('/iframe.html')) {
        const color = readFileSync(join(dir, 'src', 'Button.css'), 'utf8').trim();
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><body style="margin:0;padding:16px"><div id="storybook-root"><button style="width:140px;height:44px;border:0;border-radius:8px;color:#fff;font:600 14px sans-serif;background:${color}">Buy now</button></div></body></html>`);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => storybook.listen(0, '127.0.0.1', r));
    const sbPort = (storybook.address() as { port: number }).port;

    writeFileSync(join(dir, 'src', 'Button.css'), 'red\n');
    writeFileSync(join(dir, 'src', 'Button.stories.tsx'), "export default { title: 'Button' };\nexport const Primary = {};\n");
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'site', scripts: { storybook: `storybook dev -p ${sbPort}` } }));
    mkdirSync(join(dir, '.designer'));
    writeFileSync(join(dir, '.designer', 'canvas.json'), JSON.stringify({ version: 1, doc: { version: 1, name: 'x', root: ['n1'], nodes: { n1: { id: 'n1', type: 'code', name: 'Button / Primary', x: 0, y: 0, w: 140, h: 44, code: { kind: 'component', storyId: 'button--primary', src: null, title: 'Button / Primary', hug: true, args: {} } } }, comments: [], page: { name: 'Page 1', background: '#F5F5F5' } }, assets: {} }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Add the button');
    git(dir, 'push', '-q');

    gh = fakeGh(repo.root);
    process.env.DESIGNER_CLAUDE_PATH = join(__dirname, 'fixtures', 'fake-claude.mjs');
    process.env.FAKE_CLAUDE_FILE = 'src/Button.css';
    process.env.FAKE_CLAUDE_FROM = 'red';
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'designer-ws-')));
    // Past the first-run welcome, and without the automatic setup (this test runs its own Storybook).
    mkdirSync(join(ws, '.designer'));
    writeFileSync(join(ws, '.designer', 'settings.json'), JSON.stringify({ onboardedAt: new Date().toISOString() }));
    server = await startServer({ staticDir: web, initialProject: dir, workspace: ws, gh: gh.bin, settleMs: 100, autoSetup: false });
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: browserPath });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: shotsDir ? 2 : 1 });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(server.url);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    storybook?.close();
    delete process.env.FAKE_CLAUDE_FILE;
    delete process.env.FAKE_CLAUDE_FROM;
  });

  const snap = async (name: string) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  };

  it('takes before and after pictures when Claude changes a component', async () => {
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const box = page.locator('textarea');
    await box.waitFor({ timeout: 20000 });
    // Wait until Claude Code has started and reported its models (the model menu turns on).
    await page.locator('button.pill.ghost:not([disabled])').first().waitFor({ timeout: 20000 });
    await box.fill('blue');
    await box.press('Enter');
    await page.getByRole('button', { name: 'Allow' }).click({ timeout: 20000 });
    await page.getByText(/Visual review ready: 1 of 1 view changed/).waitFor({ timeout: 30000 });
    expect(readFileSync(join(repo.dir, 'src', 'Button.css'), 'utf8')).toBe('blue\n');

    await page.getByRole('tab', { name: /Inspect/ }).click();
    const card = page.getByTestId('review-card').first();
    await card.waitFor();
    await expect(card.textContent()).resolves.toMatch(/blue.*1 of 1 view changed/);
    await snap('1-changes-panel');

    await card.click();
    const dialog = page.getByRole('dialog', { name: 'Visual review' });
    await dialog.getByAltText('Button / Primary after').waitFor();
    const widths = await dialog.locator('img').evaluateAll((imgs) => (imgs as HTMLImageElement[]).map((i) => i.naturalWidth));
    expect(widths.length).toBe(2);
    expect(widths.every((w) => w > 0)).toBe(true);
    await expect(dialog.textContent()).resolves.toMatch(/of pixels changed/);
    await snap('2-before-after');
    await dialog.getByRole('button', { name: 'Slider' }).click();
    await dialog.getByRole('slider').fill('30');
    await snap('3-slider');
    await dialog.getByRole('button', { name: 'Highlight' }).click();
    await dialog.getByAltText('Button / Primary changes highlighted').waitFor();
    await snap('4-highlight');
    await dialog.getByRole('button', { name: 'Close' }).click();
  }, 90000);

  it('sends the change for review with the screenshots in one click', async () => {
    await page.getByRole('button', { name: 'Share for review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share for review' });
    await expect(dialog.getByPlaceholder(/Denser pricing cards/).inputValue()).resolves.toBe('blue');
    await dialog.getByPlaceholder(/Denser pricing cards/).fill('Make the buy button blue');
    await snap('5-share-dialog');
    await dialog.getByRole('button', { name: 'Send for review' }).click();
    await dialog.getByRole('button', { name: 'Open the review' }).waitFor({ timeout: 30000 });
    await snap('6-sent');
    const call = gh.calls().find((c) => c.args[1] === 'create')!;
    const branch = call.args[call.args.indexOf('--head') + 1];
    expect(branch).toMatch(/^design\/make-the-buy-button-blue-/);
    expect(call.body).toMatch(/<img src="https:\/\/github\.com\/acme\/site\/blob\/[0-9a-f]{40}\/reviews\/design\/.+-before\.png\?raw=true"/);
    expect(call.body).toContain('- `src/Button.css`');
    expect(git(repo.bare, 'log', '--format=%s', branch).split('\n')[0]).toBe('Make the buy button blue');
    expect(git(repo.bare, 'log', '--format=%s', 'main').split('\n')[0]).toBe('Add the button');
    expect(git(repo.bare, 'ls-tree', '-r', '--name-only', 'designer-screenshots')).toMatch(/-after\.png/);
    await dialog.getByRole('button', { name: 'Done' }).click();
  }, 60000);

  it('shows version history and makes a variation without git words', async () => {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const first = page.getByTestId('version').first();
    await first.waitFor();
    await expect(first.textContent()).resolves.toContain('Make the buy button blue');
    await page.getByRole('button', { name: '+ New' }).click();
    await page.getByPlaceholder('Name, e.g. Dark mode').fill('Dark mode');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText(/You are now working on the variation “Dark mode”/).waitFor();
    await expect(page.getByTestId('variation').filter({ hasText: 'Dark mode' }).getAttribute('class')).resolves.toContain('on');
    expect(git(repo.dir, 'branch', '--show-current')).toBe('design/dark-mode');

    await page.getByRole('button', { name: 'Add to version history…' }).click();
    await page.getByPlaceholder('Title').fill('Dark start');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved “Dark start” to version history.').waitFor();
    expect(git(repo.dir, 'tag', '-l')).toBe('version/dark-start');
    await snap('7-versions');
  }, 60000);
});
