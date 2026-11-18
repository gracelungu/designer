// Smoke test in a real browser: the built Designer UI on a copy of a small repo, with a stand-in
// Figma desktop server and Claude Code CLI. Run: npm run smoke:ui
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server/index';
import { onboardedWorkspace } from '../fixtures/workspace';
import { fakeFigma } from '../fixtures/fakeFigma';

// Playwright is not a dependency of the app (it comes with the dev machine or CI image), so it is loaded untyped.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type Page = any;

const WEB = join(__dirname, '..', '..', 'dist', 'web');
const SHOTS = process.env.SHOTS;

describe('smoke (browser): one source of truth for tokens', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let figma: Awaited<ReturnType<typeof fakeFigma>>;
  let browser: Browser;
  let page: Page;
  let repo: string;
  const errors: string[] = [];
  const shot = async (name: string) => SHOTS && (await page.screenshot({ path: join(SHOTS, `${name}.png`) }));
  const mcp = (name: string, args: unknown) =>
    fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'x-designer-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }).then((r) => r.json());

  beforeAll(async () => {
    if (!existsSync(join(WEB, 'index.html'))) throw new Error('Build the UI first: npm run build');
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'designer-ui-')));
    cpSync(join(__dirname, '..', 'fixtures', 'token-repo'), repo, { recursive: true });
    figma = await fakeFigma({ selection: '', variables: JSON.stringify({ 'Color/Primary': '#2563EB', 'Radius/Card': '12', 'Space/4': '16', 'Color/Success': '#16A34A' }) });
    process.env.DESIGNER_CLAUDE_PATH = join(__dirname, '..', 'fixtures', 'fake-claude.mjs');
    server = await startServer({ port: 0, staticDir: WEB, initialProject: repo, workspace: onboardedWorkspace(), figmaUrls: [figma.url], autoSetup: false });
    const { chromium } = createRequire(import.meta.url)('playwright');
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByRole('tab', { name: /Code/ }).waitFor();
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
    await figma?.close();
  });

  it('shows code tokens, CSS and Tailwind, in the Tokens tab', async () => {
    await page.getByRole('tab', { name: /^Code/ }).click();
    await page.locator('.tabs.sub').getByRole('button', { name: /^Tokens/ }).click();
    await page.getByText('No Figma variables yet.').waitFor();
    expect(await page.locator('.tok-row[data-key^="colors.brand.500"]').count()).toBe(1);
    expect(await page.locator('.tok-row .tok-code', { hasText: '--color-primary' }).count()).toBeGreaterThan(0);
    await shot('1-tokens-code-only');
  });

  it('pulls from Figma and warns about drift', async () => {
    await page.getByRole('button', { name: 'Pull from Figma' }).click();
    await page.getByRole('alert').filter({ hasText: '1 token differs between Figma and code' }).waitFor();
    await expect.poll(() => page.locator('.side-switch .badge').filter({ hasText: '1!' }).count()).toBe(1);
    const row = page.locator('.tok-row[data-key="Radius/Card"]');
    expect(await row.locator('.tok-status').innerText()).toMatch(/differs/i);
    expect(await row.getByRole('textbox').inputValue()).toBe('8px');
    expect(await row.innerText()).toContain('12');
    await page.getByRole('tab', { name: /Only in Figma/ }).click();
    expect(await page.locator('.tok-row[data-key="Color/Success"]').count()).toBe(1);
    await page.getByRole('tab', { name: /^All/ }).click();
    await shot('2-drift');
  });

  it('shows the tokens of the selected layer in the properties panel', async () => {
    const out = (await mcp('add_to_canvas', { nodes: [{ type: 'rect', name: 'Card', x: 40, y: 40, w: 200, h: 120, fill: '#2563EB', radius: 8 }] })) as { result: { isError?: boolean } };
    expect(out.result.isError).toBeFalsy();
    await page.getByRole('tab', { name: 'Figma', exact: true }).click();
    const tokens = page.locator('.layer-tokens');
    await tokens.waitFor();
    expect(await tokens.locator('[data-prop="Fill"]').innerText()).toContain('Color/Primary');
    expect(await tokens.locator('[data-prop="Corner radius"]').innerText()).toMatch(/Radius\/Card[\s\S]*differs/i);
    await tokens.getByRole('alert').waitFor();
    await shot('3-layer-tokens');
  });

  it('fixes drift with one click and the code follows Figma', async () => {
    await page.locator('.layer-tokens').getByRole('button', { name: 'All tokens' }).click();
    await page.locator('.tok-row[data-key="Radius/Card"]').getByRole('button', { name: 'Use Figma value' }).click();
    await expect.poll(() => page.getByRole('alert').filter({ hasText: 'differ' }).count()).toBe(0);
    expect(readFileSync(join(repo, 'src', 'styles', 'tokens.css'), 'utf8')).toContain('--radius-card: 12px;');
    expect(await page.locator('.side-switch .badge').filter({ hasText: '!' }).count()).toBe(0);
    await shot('4-in-sync');
  });

  it('edits a code token in place', async () => {
    await page.locator('.tabs.sub').getByRole('button', { name: /^Tokens/ }).click();
    const input = page.getByRole('textbox', { name: '--space-4 value' });
    await input.fill('20px');
    await input.press('Enter');
    await expect.poll(() => page.locator('.tok-row[data-key="Space/4"] .tok-status').innerText()).toMatch(/differs/i);
    expect(readFileSync(join(repo, 'src', 'styles', 'tokens.css'), 'utf8')).toContain('--space-4: 20px;');
  });

  it('had no page errors', () => {
    expect(errors).toEqual([]);
  });
});
