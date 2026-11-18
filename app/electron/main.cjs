// Designer for Mac: the same local server and UI, in a native window.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let server;

async function createWindow() {
  const root = path.join(__dirname, '..');
  // Read PATH and exported variables (e.g. ANTHROPIC_API_KEY) from the login shell,
  // because apps opened from Finder don't inherit them, then start the server.
  const claude = await import(pathToFileURL(path.join(root, 'dist', 'server', 'index.mjs')).href);
  await claude.loadLoginShellEnv();
  server = await claude.startServer({ port: 0, staticDir: path.join(root, 'dist', 'web') });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Designer',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(server.url);
  if (process.env.DESIGNER_SMOKE_TEST) {
    // Used by CI and local checks: prove the window loaded the UI, then quit.
    const title = await win.webContents.executeJavaScript('document.title');
    const text = await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(document.body.innerText.slice(0, 200)), 1500))');
    console.log(`SMOKE_OK title=${title} url=${server.url} body=${JSON.stringify(text)}`);
    app.quit();
  }
}

ipcMain.handle('designer:pick-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Open a project folder' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('designer:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

app.whenReady().then(createWindow).catch((e) => {
  dialog.showErrorBox('Designer could not start', String(e && e.stack ? e.stack : e));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server && server.close());
