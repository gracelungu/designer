// Designer for Mac: the same local server and UI, in a native window.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createUpdater } = require('./updater.cjs');

let server;
let win;

// Tests and CI point Designer at a throwaway folder instead of ~/Designer.
if (process.env.DESIGNER_USER_DATA) app.setPath('userData', process.env.DESIGNER_USER_DATA);

const pkg = require('../package.json');
const updater = createUpdater({
  currentVersion: app.getVersion(),
  packaged: app.isPackaged && !process.env.DESIGNER_SMOKE_TEST,
  signed: pkg.designerSigned === true,
  autoUpdater: loadAutoUpdater(),
  onState: (s) => win && !win.isDestroyed() && win.webContents.send('designer:update-state', s),
});

function loadAutoUpdater() {
  if (!app.isPackaged || pkg.designerSigned !== true) return undefined;
  try {
    return require('electron-updater').autoUpdater;
  } catch {
    return undefined;
  }
}

/** The demo project ships as an extra resource in the app; in development it sits next to the code. */
function demoDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'demo') : path.join(__dirname, '..', 'demo');
}

function buildMenu() {
  const check = { label: 'Check for Updates…', enabled: app.isPackaged, click: () => void updater.check() };
  const template = [
    ...(process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'about' }, check, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(process.platform === 'darwin' ? [] : [check]),
        { label: 'Show Welcome Again', click: () => void showWelcomeAgain() },
        { label: 'Designer on GitHub', click: () => shell.openExternal(pkg.homepage) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showWelcomeAgain() {
  if (!server || !win) return;
  await fetch(`${server.url}/api/onboarding/reset`, { method: 'POST', headers: { 'x-designer-token': server.token, 'content-type': 'application/json' }, body: '{}' });
  win.reload();
}

async function createWindow() {
  const root = path.join(__dirname, '..');
  // Read PATH and exported variables (e.g. ANTHROPIC_API_KEY) from the login shell,
  // because apps opened from Finder don't inherit them, then start the server.
  const claude = await import(pathToFileURL(path.join(root, 'dist', 'server', 'index.mjs')).href);
  if (!process.env.DESIGNER_SMOKE_TEST) await claude.loadLoginShellEnv();
  server = await claude.startServer({
    port: 0,
    staticDir: path.join(root, 'dist', 'web'),
    demoDir: demoDir(),
    workspace: process.env.DESIGNER_WORKSPACE || undefined,
  });

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Designer',
    show: !process.env.DESIGNER_SMOKE_TEST,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(server.url);
  if (process.env.DESIGNER_SMOKE_TEST) return smokeTest();
  updater.start();
}

/** Used by CI and `npm run test:smoke`: prove the packaged app starts, serves the UI and finds its demo, then quit. */
async function smokeTest() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(code)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  const report = {
    title: await js('document.title'),
    url: server.url,
    onboarding: await waitFor('!!document.querySelector("[data-testid=onboarding]")'),
    native: await js('!!(window.designerNative && window.designerNative.isElectron && window.designerNative.onUpdate)'),
    update: (await js('window.designerNative.getUpdate()')).state,
    demo: (await fetch(`${server.url}/api/status`, { headers: { 'x-designer-token': server.token } }).then((r) => r.json())).demo,
    body: (await js('document.body.innerText')).slice(0, 120),
  };
  const ok = report.title === 'Designer' && report.onboarding && report.native && report.demo;
  console.log(`${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${JSON.stringify(report)}`);
  app.exit(ok ? 0 : 1);
}

ipcMain.handle('designer:pick-folder', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], title: 'Open a project folder' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('designer:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('designer:update-get', () => updater.state);
ipcMain.on('designer:update-check', () => void updater.check());
ipcMain.on('designer:update-install', () => updater.install());

app.whenReady().then(() => {
  buildMenu();
  return createWindow();
}).catch((e) => {
  if (process.env.DESIGNER_SMOKE_TEST) {
    console.log(`SMOKE_FAIL ${e && e.stack ? e.stack : e}`);
    return app.exit(1);
  }
  dialog.showErrorBox('Designer could not start', String(e && e.stack ? e.stack : e));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server && server.close());
