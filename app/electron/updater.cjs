// Keeps the Mac app up to date from GitHub releases.
//
// Signed builds update themselves with electron-updater: the new version downloads in
// the background and a "Restart to update" pill appears. macOS refuses to swap in an
// unsigned app, so unsigned builds instead ask GitHub for the latest release and show
// "Designer x.y.z is out · Download", which opens the release page.

const REPO = { owner: 'gracelungu', repo: 'designer' };
const FIRST_CHECK_MS = 10 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/** Compare dotted versions ("v1.2.10" > "1.2.9"). Pre-release tags sort before the release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

/**
 * @param {object} o
 * @param {string} o.currentVersion
 * @param {boolean} o.packaged      only installed apps update; `npm run electron` does not
 * @param {boolean} o.signed        set at build time when the app was code signed
 * @param {object} [o.autoUpdater]  electron-updater's autoUpdater (signed builds)
 * @param {typeof fetch} [o.fetch]
 * @param {(s: object) => void} [o.onState]
 * @param {(fn: () => void, ms: number) => unknown} [o.setTimeout]
 * @param {(fn: () => void, ms: number) => unknown} [o.setInterval]
 */
function createUpdater(o) {
  const fetchImpl = o.fetch ?? globalThis.fetch;
  let state = { state: o.packaged ? 'idle' : 'disabled' };
  const set = (s) => {
    state = s;
    o.onState?.(state);
  };

  async function checkGitHub() {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Designer-updater' },
    });
    if (res.status === 404) return set({ state: 'none' }); // no release published yet
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    if (version && isNewer(version, o.currentVersion)) set({ state: 'available', version, url: release.html_url });
    else set({ state: 'none' });
  }

  const au = o.signed ? o.autoUpdater : undefined;
  if (au) {
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.on('checking-for-update', () => set({ state: 'checking' }));
    au.on('update-not-available', () => set({ state: 'none' }));
    au.on('update-available', (info) => set({ state: 'downloading', version: info?.version, percent: 0 }));
    au.on('download-progress', (p) => set({ ...state, state: 'downloading', percent: p?.percent }));
    au.on('update-downloaded', (info) => set({ state: 'ready', version: info?.version }));
    au.on('error', (e) => set({ state: 'error', error: String(e?.message ?? e) }));
  }

  async function check() {
    if (!o.packaged) return state;
    if (state.state === 'ready' || state.state === 'downloading') return state;
    set({ state: 'checking' });
    try {
      if (au) await au.checkForUpdates();
      else await checkGitHub();
    } catch (e) {
      // A signed build that cannot self-update still learns about new releases.
      if (au) await checkGitHub().catch(() => set({ state: 'error', error: String(e?.message ?? e) }));
      else set({ state: 'error', error: String(e?.message ?? e) });
    }
    return state;
  }

  function start() {
    if (!o.packaged) return;
    (o.setTimeout ?? setTimeout)(() => void check(), FIRST_CHECK_MS);
    (o.setInterval ?? setInterval)(() => void check(), EVERY_MS);
  }

  function install() {
    if (state.state === 'ready' && au) au.quitAndInstall();
  }

  return { check, start, install, get state() { return state; } };
}

module.exports = { createUpdater, compareVersions, isNewer, REPO };
