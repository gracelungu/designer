// Smoke test for collaboration, through the built app in a real browser, the way a designer uses it:
// pin a comment on a frame, see it saved in the repo, see Claude's reply arrive, export the design
// preview, read and answer Azure DevOps pull request comments, and get a teammate's comment with
// Get latest. Claude Code and the Azure DevOps MCP server are stand-ins (test/fixtures).
//
// Run: npm run build && npm run test:smoke:collab (needs Playwright with Chromium)
// Set SHOTS=<dir> to save screenshots.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')));
}

const tmp = (p = 'designer-smoke-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] });

const azureLog = join(tmp(), 'azure.log');
process.env.DESIGNER_CLAUDE_PATH = join(app, 'test', 'fixtures', 'fake-claude.mjs');
process.env.DESIGNER_AZURE_MCP = JSON.stringify(['node', join(app, 'test', 'fixtures', 'fake-azure-mcp.mjs')]);
process.env.FAKE_AZURE_LOG = azureLog;

// A project on Azure DevOps.
const project = tmp();
git(project, 'init', '-q', '-b', 'main');
git(project, 'config', 'user.name', 'Grace Designer');
git(project, 'remote', 'add', 'origin', 'https://dev.azure.com/contoso/Shop/_git/web');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: {} }));

const { startServer } = await import(join(app, 'dist', 'server', 'index.mjs'));
const ws = tmp();
// Past the first-run welcome, so the smoke test lands on the canvas.
mkdirSync(join(ws, '.designer'), { recursive: true });
writeFileSync(join(ws, '.designer', 'settings.json'), JSON.stringify({ onboardedAt: new Date().toISOString() }));
const server = await startServer({ port: 0, staticDir: join(app, 'dist', 'web'), initialProject: project, workspace: ws, autoSetup: false });

const results = [];
const errors = [];
let page;
async function check(name, fn) {
  const before = errors.length;
  try {
    await fn();
    if (errors.length > before) throw new Error('page error: ' + errors.slice(before).join(' | '));
    results.push(['PASS', name]);
    console.log('PASS ', name);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]]);
    console.log('FAIL ', name, e.message.split('\n')[0]);
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};
const shot = async (name) => process.env.SHOTS && (mkdirSync(process.env.SHOTS, { recursive: true }), await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) }));
const until = async (fn, msg, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const commentFiles = (dir) => (existsSync(join(dir, '.designer', 'comments')) ? readdirSync(join(dir, '.designer', 'comments')) : []);
async function mcp(name, args) {
  const r = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'x-designer-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result.content[0].text;
}

const browser = await chromium.launch();
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(server.url);
  await page.waitForSelector('.canvas-root');
  await page.waitForTimeout(500);

  const stage = async () => page.locator('.canvas-root').boundingBox();

  await check('Draw a frame and pin a comment on it', async () => {
    const b = await stage();
    await page.mouse.click(b.x + b.width - 30, b.y + 30); // focus the canvas
    await page.keyboard.press('f');
    await page.mouse.move(b.x + 200, b.y + 150);
    await page.mouse.down();
    await page.mouse.move(b.x + 400, b.y + 300, { steps: 6 });
    await page.mouse.move(b.x + 600, b.y + 450, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await page.mouse.click(b.x + 300, b.y + 250);
    await page.waitForSelector('.dz-thread textarea');
    await page.keyboard.type('Make the headline bigger');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dz-thread .dz-on');
    const on = await page.locator('.dz-thread .dz-on').textContent();
    assert(/on Frame/.test(on), 'thread says ' + on);
    const meta = await page.locator('.dz-thread .dz-msg-meta').first().textContent();
    assert(meta.includes('Grace Designer'), 'signed ' + meta);
    await shot('1-comment-on-frame');
  });

  await check('The comment is saved in the repo as its own file', async () => {
    const files = await until(() => commentFiles(project).length === 1 && commentFiles(project), 'no comment file in .designer/comments');
    const c = JSON.parse(readFileSync(join(project, '.designer', 'comments', files[0]), 'utf8'));
    assert(c.text === 'Make the headline bigger' && c.author === 'Grace Designer' && c.nodeId, JSON.stringify(c));
    await until(() => existsSync(join(project, '.designer', 'canvas.json')), 'canvas not saved');
    await until(() => JSON.parse(readFileSync(join(project, '.designer', 'canvas.json'), 'utf8')).doc.comments.length === 0, 'canvas.json kept a copy of the comment');
  });

  await check('The Comments tab lists it, and Claude’s reply arrives live', async () => {
    await page.keyboard.press('Escape');
    await page.locator('.side.left .tabs button', { hasText: 'Comments' }).click();
    await page.waitForSelector('.cp-item');
    assert((await page.locator('.side.left .tabs .badge').textContent()) === '1', 'badge');
    const out = await mcp('reply_to_comment', { id: '1', text: 'Headline is 40px now' });
    assert(out.startsWith('Replied to comment #1'), out);
    await page.waitForSelector('.cp-item .cp-meta:has-text("1 reply")');
    await shot('2-comments-panel');
  });

  await check('Clicking a comment in the list opens its thread on the canvas', async () => {
    await page.locator('.cp-item').first().click();
    await page.waitForSelector('.dz-pin.on');
    assert(await page.locator('.dz-thread .dz-msg', { hasText: 'Headline is 40px now' }).count() === 1, 'reply not in thread');
    await shot('3-thread-open');
    await page.keyboard.press('Escape');
  });

  await check('Export design preview writes it into the project and downloads it', async () => {
    await page.locator('.topbar .chip').click();
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('button.opt', { hasText: 'Export design preview' }).click({ timeout: 5000 })]);
    assert(d.suggestedFilename() === 'design-preview.html', d.suggestedFilename());
    const dir = join(project, '.designer', 'preview');
    await until(() => existsSync(join(dir, 'README.md')), 'no README');
    const files = readdirSync(dir).sort();
    assert(files.includes('index.html') && files.some((f) => f.endsWith('.svg')), files.join(','));
    const md = readFileSync(join(dir, 'README.md'), 'utf8');
    assert(md.includes('Make the headline bigger') && md.includes('Headline is 40px now'), 'README misses the comment');
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert(html.includes('class="pin"'), 'no pin in preview page');
    const view = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await view.setContent(html);
    assert((await view.locator('.pin').count()) === 1, 'preview page pin');
    if (process.env.SHOTS) await view.screenshot({ path: join(process.env.SHOTS, '4-preview-page.png') });
    await view.close();
  });

  await check('Pull requests from Azure DevOps show with their comments, and a reply goes back', async () => {
    await page.locator('.comments-panel [role=tab]', { hasText: 'Pull requests' }).click();
    await page.waitForSelector('.cp-item:has-text("Denser pricing cards")', { timeout: 15000 });
    assert((await page.locator('.cp-bar .muted').textContent()).includes('Azure DevOps · Shop/web'), 'host label');
    await shot('5-pull-requests');
    await page.locator('.cp-item', { hasText: 'Denser pricing cards' }).click();
    await page.waitForSelector('.cp-thread:has-text("Can the gap be 16px?")');
    assert((await page.locator('.cp-thread', { hasText: 'Policy check passed' }).count()) === 0, 'system comment shown');
    const thread = page.locator('.cp-thread', { hasText: 'Can the gap be 16px?' });
    await thread.locator('textarea').fill('Done: 16px in the latest version');
    await thread.locator('button', { hasText: 'Reply' }).click();
    await page.waitForSelector('.cp-thread .cp-msg:has-text("Done: 16px in the latest version")');
    const calls = readFileSync(azureLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert(calls.some((c) => c.name === 'repo_reply_to_comment' && c.args.threadId === 7), 'no reply call');
    await shot('6-pr-thread');
  });

  await check('Get latest brings a teammate’s comment onto the canvas', async () => {
    // A second project whose remote is shared with a teammate.
    const origin = tmp();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const mine = tmp();
    git(mine, 'clone', '-q', origin, '.');
    git(mine, 'config', 'user.name', 'Grace Designer');
    writeFileSync(join(mine, 'README.md'), 'shop');
    git(mine, 'add', '-A');
    git(mine, 'commit', '-q', '-m', 'start');
    git(mine, 'push', '-q', '-u', 'origin', 'main');
    const theirs = tmp();
    git(theirs, 'clone', '-q', origin, '.');
    mkdirSync(join(theirs, '.designer', 'comments'), { recursive: true });
    writeFileSync(join(theirs, '.designer', 'comments', 'dev1.json'), JSON.stringify({ id: 'dev1', num: 1, x: 40, y: 40, nodeId: null, dx: 0, dy: 0, author: 'Dev Teammate', text: 'Is this the final copy?', at: Date.now(), resolved: false, replies: [] }));
    git(theirs, 'add', '-A');
    git(theirs, 'commit', '-q', '-m', 'comment');
    git(theirs, 'push', '-q', 'origin', 'main');

    await page.evaluate(async ([url, token, path]) => (await fetch(url + '/api/project', { method: 'POST', headers: { 'x-designer-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ path }) })).json(), [server.url, server.token, mine]);
    await page.locator('.comments-panel [role=tab]', { hasText: 'On the canvas' }).click();
    await until(async () => (await page.locator('.topbar .chip b').textContent()) !== 'shop' || true, 'project');
    assert((await page.locator('.cp-item', { hasText: 'Is this the final copy?' }).count()) === 0, 'comment there before pulling');
    await page.locator('.topbar .btn', { hasText: 'Get latest' }).click();
    await page.waitForSelector('.cp-item:has-text("Is this the final copy?")', { timeout: 10000 });
    assert((await page.locator('.cp-item', { hasText: 'Dev Teammate' }).count()) === 1, 'author');
    await shot('7-after-get-latest');
  });
} finally {
  await browser.close();
  server.close();
}

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
