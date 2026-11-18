import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { buildConfig } = require('../build/builder-config.cjs') as { buildConfig: (env: Record<string, string | undefined>) => Record<string, any> };
const root = join(__dirname, '..');

describe('Mac build settings', () => {
  it('builds unsigned when there is no certificate', () => {
    const c = buildConfig({});
    expect(c.mac.identity).toBeNull();
    expect(c.mac.hardenedRuntime).toBe(false);
    expect(c.mac.notarize).toBe(false);
    expect(c.extraMetadata.designerSigned).toBe(false);
  });

  it('signs with the hardened runtime when CSC_LINK is set, but only notarizes with all Apple secrets', () => {
    const signed = buildConfig({ CSC_LINK: 'base64cert' });
    expect(signed.mac.identity).toBeUndefined();
    expect(signed.mac.hardenedRuntime).toBe(true);
    expect(signed.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(existsSync(join(root, signed.mac.entitlements))).toBe(true);
    expect(signed.mac.notarize).toBe(false);
    expect(signed.extraMetadata.designerSigned).toBe(true);

    const full = buildConfig({ CSC_LINK: 'x', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' });
    expect(full.mac.notarize).toBe(true);
    // Apple secrets alone, without a certificate, cannot notarize.
    expect(buildConfig({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }).mac.notarize).toBe(false);
  });

  it('builds both chips as dmg and the zip auto-update needs', () => {
    const t = buildConfig({}).mac.target as { target: string; arch: string[] }[];
    expect(t.map((x) => x.target)).toEqual(['dmg', 'zip']);
    for (const x of t) expect(x.arch).toEqual(['x64', 'arm64']);
  });

  it('publishes releases to this repository and ships the demo without its build output', () => {
    const c = buildConfig({});
    expect(c.publish[0]).toMatchObject({ provider: 'github', owner: 'gracelungu', repo: 'designer' });
    expect(c.extraResources[0]).toMatchObject({ from: 'demo', to: 'demo' });
    expect(c.extraResources[0].filter).toContain('!node_modules/**');
  });

  it('keeps the package scripts and the electron-builder entry in step', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.build).toBeUndefined();
    expect(pkg.scripts['dist:mac']).toContain('--config electron-builder.config.cjs');
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
    expect(require('../electron-builder.config.cjs').appId).toBe('dev.designer.app');
  });
});

describe('GitHub workflows', () => {
  const wf = (n: string) => readFileSync(join(root, '..', '.github', 'workflows', n), 'utf8');
  it('CI runs every test suite on pull requests', () => {
    const ci = wf('ci.yml');
    expect(ci).toMatch(/pull_request/);
    for (const step of ['npm run typecheck', 'npm run lint', 'npm test', 'npm run test:e2e', 'editor/tests/e2e.cjs', 'test/smoke/electron-smoke.mjs']) expect(ci).toContain(step);
  });
  it('the Mac workflow signs only with secrets and publishes on version tags', () => {
    const mac = wf('mac.yml');
    expect(mac).toMatch(/tags:\s*\n\s*- 'v\*'/);
    expect(mac).toContain('secrets.CSC_LINK');
    expect(mac).toContain('CSC_IDENTITY_AUTO_DISCOVERY');
    expect(mac).toContain('--publish always');
    expect(mac).toContain('electron-smoke.mjs');
  });
});
