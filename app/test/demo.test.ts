import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_NAME, demoAvailable, installDemo } from '../src/server/demo';
import { git, projectInfo } from '../src/server/project';
import { findTokens } from '../src/server/tokens';
import { readSettings, writeSettings } from '../src/server/settings';

const DEMO = join(__dirname, '..', 'demo');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'designer-demo-')));

describe('bundled demo project', () => {
  it('is bundled with a package, stories and tokens', async () => {
    expect(await demoAvailable(DEMO)).toBe(true);
    expect(await demoAvailable(undefined)).toBe(false);
    expect(await demoAvailable(join(DEMO, 'nope'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(DEMO, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).toBeTruthy();
    expect(pkg.scripts.storybook).toContain('--ci');
  });

  it('is copied into the workspace as a git repo, with its dotfiles', async () => {
    const ws = tmp();
    const { path, created } = await installDemo(DEMO, ws);
    expect(created).toBe(true);
    expect(path).toBe(join(ws, DEMO_NAME));
    expect(existsSync(join(path, '.storybook', 'main.ts'))).toBe(true);
    expect(existsSync(join(path, '.gitignore'))).toBe(true);
    expect(existsSync(join(path, 'CLAUDE.md'))).toBe(true);
    const log = await git(path, ['log', '--format=%s']).catch(() => '');
    if (log) expect(log.trim()).toBe('Start from the Designer demo');
  });

  it('keeps the designer’s edits when opened again, and makes a new copy on request', async () => {
    const ws = tmp();
    const first = await installDemo(DEMO, ws);
    writeFileSync(join(first.path, 'note.txt'), 'mine');
    const again = await installDemo(DEMO, ws);
    expect(again).toEqual({ path: first.path, created: false });
    expect(readFileSync(join(again.path, 'note.txt'), 'utf8')).toBe('mine');
    const fresh = await installDemo(DEMO, ws, { fresh: true });
    expect(fresh.path).toBe(join(ws, `${DEMO_NAME} 2`));
    expect(existsSync(join(fresh.path, 'note.txt'))).toBe(false);
  });

  it('fails clearly when the build has no demo', async () => {
    await expect(installDemo(join(tmp(), 'missing'), tmp())).rejects.toThrow(/not bundled/);
  });

  it('shows its components and tokens in Designer', async () => {
    const { path } = await installDemo(DEMO, tmp());
    const info = await projectInfo(path);
    expect(info.stories.map((s) => s.title)).toEqual(['Components/Badge', 'Components/Button', 'Components/PriceCard']);
    expect(info.stories.find((s) => s.title === 'Components/Button')?.stories.map((s) => s.id)).toEqual(['components-button--primary', 'components-button--secondary', 'components-button--large']);
    const list = await findTokens(path);
    expect(list.find((t) => t.name === '--color-primary')?.kind).toBe('color');
    expect(list.find((t) => t.name === '--radius-md')?.kind).toBe('size');
  });
});

describe('app settings', () => {
  it('start empty, then remember onboarding', async () => {
    const ws = tmp();
    expect(await readSettings(ws)).toEqual({});
    await writeSettings(ws, { onboardedAt: '2026-11-18T00:00:00Z', startedWith: 'demo' });
    expect(await readSettings(ws)).toEqual({ onboardedAt: '2026-11-18T00:00:00Z', startedWith: 'demo' });
    expect(existsSync(join(ws, '.designer', 'settings.json'))).toBe(true);
  });
  it('survive a damaged file', async () => {
    const ws = tmp();
    await writeSettings(ws, {});
    writeFileSync(join(ws, '.designer', 'settings.json'), '{oops');
    expect(await readSettings(ws)).toEqual({});
  });
});
