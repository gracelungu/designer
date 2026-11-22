import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import type { Store } from '../../../editor/src/index.js';
import { startServer } from '../../src/server/index';

it('automatically publishes from one Designer window and joins and updates from another', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'designer-team-ui-')));
  const remote = join(root, 'remote.git');
  const alice = join(root, 'alice');
  const bob = join(root, 'bob');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const branch = 'design/new-navigation';
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, alice);
  writeFileSync(join(alice, 'README.md'), 'Project');
  git(alice, 'config', 'user.name', 'Alice');
  git(alice, 'config', 'user.email', 'alice@example.invalid');
  git(alice, 'add', '.');
  git(alice, 'commit', '-m', 'Initial');
  git(alice, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, bob);
  git(alice, 'switch', '-c', branch);
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];

  async function open(path: string) {
    const server = await startServer({ staticDir: join(__dirname, '../../dist/web'), initialProject: path, workspace: join(root, 'app-' + servers.length) });
    servers.push(server);
    await fetch(`${server.url}/api/onboarding`, {
      method: 'POST', headers: { 'x-designer-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ startedWith: 'project' }),
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(7500);
    await page.goto(server.url);
    await page.getByText(path === alice ? 'alice' : 'bob', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Versions', exact: true }).click();
    return page;
  }
  async function edit(page: Page, name: string) {
    await page.evaluate((name) => {
      const { store } = (window as unknown as { __designer: { host: { editor: { store: Store } } } }).__designer.host.editor;
      store.transact(() => { store.create('frame', { name, w: 200, h: 150 }); });
    }, name);
  }
  const published = () => {
    try { return git(remote, 'show', `${branch}:.designer/canvas.json`); } catch { return ''; }
  };

  try {
    const sender = await open(alice);
    await sender.clock.install();
    await sender.getByText('Shared workspace', { exact: true }).click();
    await sender.getByRole('button', { name: 'Set up shared workspace' }).click();
    await sender.getByRole('textbox', { name: 'Workspace name' }).fill('Product design');
    await sender.getByRole('button', { name: 'Create and track workspace' }).click();
    await sender.getByText('Product design · Changes waiting for a commit').waitFor();
    expect(git(alice, 'diff', '--cached', '--name-only')).toBe('.designer/workspace.json');
    await edit(sender, 'First review');
    await sender.getByRole('checkbox', { name: 'Automatically sync this branch' }).click();
    await sender.getByText('Automatic sync enabled', { exact: false }).waitFor();
    await sender.clock.fastForward(31_000);
    await expect.poll(published, { timeout: 8000 }).toContain('First review');

    const teammate = await open(bob);
    await teammate.getByRole('button', { name: 'Refresh branches' }).click();
    await teammate.getByRole('button', { name: 'New navigation · team branch' }).click();
    await teammate.locator('[data-testid="variation"].on', { hasText: 'New navigation' }).waitFor();
    await teammate.getByText('Shared workspace', { exact: true }).click();
    await teammate.getByText('Product design · Tracked in Git').waitFor();
    await teammate.getByRole('button', { name: 'Layers', exact: true }).click();
    await teammate.getByRole('tree').getByText('First review', { exact: true }).waitFor();

    await edit(sender, 'Second review');
    await sender.getByRole('button', { name: 'Sync design now' }).click();
    await expect.poll(published, { timeout: 8000 }).toContain('Second review');
    await teammate.getByRole('button', { name: 'Versions', exact: true }).click();
    await teammate.getByRole('button', { name: 'Sync design now' }).click();
    await teammate.getByText('Received the team’s changes', { exact: false }).waitFor();
    await teammate.getByRole('button', { name: 'Layers', exact: true }).click();
    await teammate.getByRole('tree').getByText('Second review', { exact: true }).waitFor();
  } finally {
    await browser.close();
    for (const server of servers) server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
