import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createUpdater, compareVersions, isNewer } = require('../electron/updater.cjs') as any;

const release = (tag: string, status = 200) =>
  vi.fn(async () => ({ ok: status < 300, status, json: async () => ({ tag_name: tag, html_url: `https://github.com/gracelungu/designer/releases/tag/${tag}` }) }));

class FakeAutoUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  installed = false;
  constructor(private behave: (self: FakeAutoUpdater) => Promise<void>) {
    super();
  }
  checkForUpdates() {
    return this.behave(this);
  }
  quitAndInstall() {
    this.installed = true;
  }
}

describe('version compare', () => {
  it('orders versions numerically, with pre-releases first', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  });
});

describe('updater', () => {
  it('does nothing in development builds', async () => {
    const fetch = release('v9.0.0');
    const u = createUpdater({ currentVersion: '0.1.0', packaged: false, signed: false, fetch });
    expect((await u.check()).state).toBe('disabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('unsigned builds point to the release page when a newer version is out', async () => {
    const states: { state: string }[] = [];
    const u = createUpdater({ currentVersion: '0.1.0', packaged: true, signed: false, fetch: release('v0.2.0'), onState: (s: { state: string }) => states.push(s) });
    const s = await u.check();
    expect(s).toEqual({ state: 'available', version: '0.2.0', url: 'https://github.com/gracelungu/designer/releases/tag/v0.2.0' });
    expect(states.map((x) => x.state)).toEqual(['checking', 'available']);
  });

  it('says up to date when the release is not newer, or none is published', async () => {
    expect((await createUpdater({ currentVersion: '0.2.0', packaged: true, signed: false, fetch: release('v0.2.0') }).check()).state).toBe('none');
    expect((await createUpdater({ currentVersion: '0.2.0', packaged: true, signed: false, fetch: release('', 404) }).check()).state).toBe('none');
  });

  it('reports a failed check as an error', async () => {
    const s = await createUpdater({ currentVersion: '0.2.0', packaged: true, signed: false, fetch: release('', 500) }).check();
    expect(s.state).toBe('error');
  });

  it('signed builds download in the background, then restart to install', async () => {
    const au = new FakeAutoUpdater(async (self) => {
      self.emit('checking-for-update');
      self.emit('update-available', { version: '0.3.0' });
      self.emit('download-progress', { percent: 50 });
      self.emit('update-downloaded', { version: '0.3.0' });
    });
    const states: { state: string; percent?: number }[] = [];
    const u = createUpdater({ currentVersion: '0.1.0', packaged: true, signed: true, autoUpdater: au, fetch: release('v0.3.0'), onState: (s: never) => states.push(s) });
    expect(au.autoDownload).toBe(true);
    const s = await u.check();
    expect(s).toEqual({ state: 'ready', version: '0.3.0' });
    expect(states.some((x) => x.state === 'downloading' && x.percent === 50)).toBe(true);
    u.install();
    expect(au.installed).toBe(true);
    // Once ready, later checks keep the downloaded update.
    expect((await u.check()).state).toBe('ready');
  });

  it('a signed build that cannot self-update still finds the new release', async () => {
    const au = new FakeAutoUpdater(async () => {
      throw new Error('Could not get code signature');
    });
    const u = createUpdater({ currentVersion: '0.1.0', packaged: true, signed: true, autoUpdater: au, fetch: release('v0.4.0') });
    expect((await u.check()).state).toBe('available');
    u.install();
    expect(au.installed).toBe(false);
  });

  it('checks shortly after launch and then every few hours', () => {
    const timeouts: number[] = [];
    const intervals: number[] = [];
    createUpdater({ currentVersion: '0.1.0', packaged: true, signed: false, fetch: release('v0.1.0'), setTimeout: (_f: () => void, ms: number) => timeouts.push(ms), setInterval: (_f: () => void, ms: number) => intervals.push(ms) }).start();
    expect(timeouts).toEqual([10000]);
    expect(intervals).toEqual([6 * 60 * 60 * 1000]);
  });
});
