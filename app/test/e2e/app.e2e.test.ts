// Drives the built Designer UI in Chromium, like a designer would, from first launch
// through the demo project, chat, tokens, canvas, Figma and versions.
// Claude Code is the stand-in at test/fixtures/fake-claude.mjs.
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server/index';

const APP = join(__dirname, '..', '..');
const STATIC = join(APP, 'dist', 'web');
const SHOTS = process.env.SHOTS;

let browser: Browser;
let page: Page;
let srv: Awaited<ReturnType<typeof startServer>>;
let workspace: string;
const errors: string[] = [];
const shot = async (name: string) => SHOTS && (await page.screenshot({ path: join(SHOTS, `${name}.png`) }));

async function openPage(url: string, init?: () => void) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  return p;
}

beforeAll(async () => {
  if (!existsSync(join(STATIC, 'index.html'))) throw new Error('Build the UI first: npm run build');
  process.env.DESIGNER_CLAUDE_PATH = join(APP, 'test', 'fixtures', 'fake-claude.mjs');
  workspace = join(realpathSync(mkdtempSync(join(tmpdir(), 'designer-e2e-'))), 'Designer');
  srv = await startServer({ workspace, staticDir: STATIC, demoDir: join(APP, 'demo') });
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  page = await openPage(srv.url);
});

afterAll(async () => {
  await browser?.close();
  srv?.close();
});

describe('first run onboarding', () => {
  it('lets you open a project, sketch or try the demo from one screen', async () => {
    await page.getByRole('heading', { name: 'Welcome to Designer' }).waitFor();
    expect(await page.getByRole('button', { name: 'Open a project', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Start with a blank canvas', exact: true }).count()).toBe(1);
    await shot('01-welcome');
    await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
  });

  it('opens a copy of the demo with its components', async () => {
    await page.locator('.chip-text b', { hasText: 'Lumen demo' }).waitFor();
    expect(existsSync(join(workspace, 'Lumen demo', 'src', 'tokens.css'))).toBe(true);
    for (const name of ['Badge', 'Button', 'PriceCard']) await page.locator('.comp-name', { hasText: new RegExp(`^${name}$`) }).waitFor();
    await shot('04-demo-open');
  });

  it('does not show onboarding on the next launch', async () => {
    const second = await openPage(srv.url);
    await second.locator('.topbar').waitFor();
    expect(await second.getByTestId('onboarding').count()).toBe(0);
    await second.context().close();
  });
});

describe('chat with Claude Code', () => {
  it('lists Claude Code’s commands and MCP servers', async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Claude Code settings' }).click();
    await page.getByText('MCP servers (1)').waitFor();
    await page.getByText('my-skill').first().waitFor();
    await page.getByRole('button', { name: /Back to chat/ }).click();
  });

  it('sends a prompt, asks permission, and shows the edit', async () => {
    const box = page.getByPlaceholder(/Ask Claude to design/);
    await box.fill('goodbye');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText(/Allow Claude to edit hello\.txt\?/i).waitFor();
    await shot('05-permission');
    await page.locator('.perm-actions').getByRole('button', { name: 'Allow' }).click();
    await page.locator('.perm-state', { hasText: 'Allowed' }).waitFor();
    await expect.poll(() => readFileSync(join(workspace, 'Lumen demo', 'hello.txt'), 'utf8')).toBe('goodbye world\n');
  });

  it('shows what Claude changed under Code', async () => {
    await page.getByRole('tab', { name: /Code/ }).click();
    await page.locator('.file-change', { hasText: 'hello.txt' }).waitFor();
    await shot('06-changes');
  });

  it('denies an edit when asked to', async () => {
    await page.getByPlaceholder('Reply to Claude…').fill('farewell');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.perm-actions').getByRole('button', { name: 'Deny' }).click();
    await page.locator('.perm-state', { hasText: 'Denied' }).waitFor();
    expect(readFileSync(join(workspace, 'Lumen demo', 'hello.txt'), 'utf8')).toBe('goodbye world\n');
  });

  it('starts a new chat', async () => {
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder(/Ask Claude to design/).waitFor();
  });
});

describe('design tokens', () => {
  it('edits a token and writes it to the stylesheet', async () => {
    await page.getByRole('tab', { name: /Code/ }).click();
    await page.getByRole('button', { name: 'Tokens' }).click();
    const row = page.locator('.tok-row', { hasText: '--radius-md' });
    await row.waitFor();
    const input = row.locator('input.tok-input');
    await input.fill('14px');
    await input.press('Enter');
    await expect.poll(() => readFileSync(join(workspace, 'Lumen demo', 'src', 'tokens.css'), 'utf8')).toContain('--radius-md: 14px;');
    await shot('07-tokens');
  });
});

describe('canvas', () => {
  it('draws a rectangle and shows it as a layer, with its code', async () => {
    const stage = page.locator('.stage-host');
    const b = (await stage.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + 40);
    await page.keyboard.press('r');
    await page.mouse.move(b.x + 300, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + 420, b.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await expect.poll(() => page.locator('.side.left').innerText()).toMatch(/Rectangle/);
    await page.getByRole('tab', { name: /Figma/ }).click();
    await shot('08-rectangle');
    await page.getByRole('tab', { name: /Code/ }).click();
    await expect.poll(() => page.locator('.side.right').innerText()).toContain('width: 120px');
    await shot('09-rectangle-code');
  });

  it('saves the canvas into the project', async () => {
    await expect.poll(() => existsSync(join(workspace, 'Lumen demo', '.designer', 'canvas.json')), { timeout: 10000 }).toBe(true);
  });
});

describe('Figma import', () => {
  it('opens and explains how to connect Figma', async () => {
    await page.getByRole('button', { name: 'Import from Figma' }).first().click();
    await expect.poll(() => page.locator('.modal').innerText(), { timeout: 15000 }).toMatch(/Figma/);
    await shot('10-figma');
    await page.keyboard.press('Escape');
    if (await page.locator('.modal-back').count()) await page.locator('.modal-back').click({ position: { x: 5, y: 5 } });
  });
});

describe('versions', () => {
  it('saves a version of the demo', async () => {
    await page.getByRole('button', { name: /Save version/ }).click();
    await page.getByPlaceholder(/Title, e.g./).fill('Rounder cards');
    await page.locator('.modal').getByRole('button', { name: 'Save version' }).click();
    await page.locator('.toast', { hasText: /Saved “Rounder cards”/ }).waitFor();
  });

  it('opens the demo again from Add a project', async () => {
    await page.locator('.chip').first().click();
    await page.getByRole('button', { name: 'Open another project…' }).click();
    await page.getByRole('button', { name: 'Open the demo project' }).click();
    await page.locator('.modal.picker').waitFor({ state: 'detached' });
    await page.locator('.chip-text b', { hasText: 'Lumen demo' }).waitFor();
  });
});

describe('Mac app updates', () => {
  it('shows Restart to update when a new version is downloaded', async () => {
    const p = await openPage(srv.url, () => {
      const w = window as unknown as Record<string, unknown>;
      w.__installs = 0;
      w.designerNative = {
        isElectron: true,
        pickFolder: async () => null,
        openExternal: () => undefined,
        getUpdate: async () => ({ state: 'ready', version: '0.2.0' }),
        onUpdate: () => () => undefined,
        installUpdate: () => (w.__installs = (w.__installs as number) + 1),
      };
    });
    await p.getByTestId('update-pill').filter({ hasText: 'Restart to update' }).click();
    expect(await p.evaluate(() => (window as unknown as { __installs: number }).__installs)).toBe(1);
    await p.context().close();
  });

  it('links to the download for unsigned builds', async () => {
    const p = await openPage(srv.url, () => {
      const w = window as unknown as Record<string, unknown>;
      w.__opened = '';
      w.designerNative = {
        isElectron: true,
        pickFolder: async () => null,
        openExternal: (u: string) => (w.__opened = u),
        getUpdate: async () => ({ state: 'available', version: '0.3.0', url: 'https://github.com/gracelungu/designer/releases/tag/v0.3.0' }),
        onUpdate: () => () => undefined,
      };
    });
    await p.getByTestId('update-pill').filter({ hasText: 'Designer 0.3.0 is out' }).click();
    expect(await p.evaluate(() => (window as unknown as { __opened: string }).__opened)).toContain('/releases/tag/v0.3.0');
    await p.context().close();
  });

  it('shows nothing in the browser version', async () => {
    expect(await page.getByTestId('update-pill').count()).toBe(0);
  });
});

describe('without Claude Code', () => {
  it('opens a custom component project and prepares a manual handoff without Claude or Storybook', async () => {
    const saved = process.env.DESIGNER_CLAUDE_PATH;
    const savedPath = process.env.PATH;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-custom-')));
    writeFileSync(join(dir, 'badge.html'), '<span class="badge">Badge</span>');
    process.env.DESIGNER_CLAUDE_PATH = '/nonexistent/claude';
    process.env.PATH = '/nonexistent';
    const bare = await startServer({ workspace: join(dir, 'Designer'), staticDir: STATIC });
    process.env.DESIGNER_CLAUDE_PATH = saved;
    process.env.PATH = savedPath;
    try {
      const p = await openPage(bare.url, () => {
        Object.defineProperty(window, 'designerNative', { value: {
          isElectron: true,
          pickFolder: async () => window.localStorage.getItem('test-project'),
          openExternal: () => undefined,
        } });
      });
      await p.evaluate((path) => localStorage.setItem('test-project', path), dir);
      await p.getByRole('button', { name: 'Open a project', exact: true }).click();
      await p.getByRole('button', { name: 'Choose folder…' }).click();
      await p.getByRole('button', { name: 'Add source', exact: true }).click();
      await p.getByRole('textbox', { name: 'Component name' }).fill('Template Badge');
      await p.getByRole('textbox', { name: 'File path in the project' }).fill('badge.html');
      await p.getByRole('button', { name: 'Add component' }).click();
      await p.getByRole('textbox', { name: 'Search components' }).fill('badge.html');
      await p.getByText('Template Badge', { exact: true }).waitFor();
      const session = await fetch(`${bare.url}/api/project/setup`, { headers: { 'x-designer-token': bare.token } });
      expect(await session.json()).toBeNull();
      await p.getByRole('button', { name: /Add editable frame/ }).click();
      await p.getByRole('tab', { name: 'Code' }).click();
      await p.getByText('Design layer linked to source').waitFor();
      await p.evaluate(() => {
        const { store } = (window as unknown as { __designer: { host: { editor: { store: import('../../../editor/src/index.js').Store } } } }).__designer.host.editor;
        store.transact(() => { store.selected()[0].radius = 12; });
      });
      await p.getByRole('button', { name: 'Review design changes' }).click();
      await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await p.getByRole('button', { name: 'Copy changes' }).click();
      await p.getByRole('button', { name: 'Copied' }).waitFor();
      expect(await p.evaluate(() => navigator.clipboard.readText())).toContain('badge.html');
      expect(await p.getByRole('button', { name: 'Propose code change' }).count()).toBe(0);
      await p.getByRole('button', { name: 'Mark implemented' }).click();
      await p.getByTestId('sync-pending').waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Chat', exact: true }).click();
      await p.getByRole('heading', { name: 'Claude Code is not installed' }).waitFor();
      await p.context().close();
    } finally {
      bare.close();
    }
  });
});

describe('page health', () => {
  it('had no uncaught errors', () => {
    expect(errors).toEqual([]);
  });
});
