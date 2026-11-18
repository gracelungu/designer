const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('designerNative', {
  isElectron: true,
  pickFolder: () => ipcRenderer.invoke('designer:pick-folder'),
  openExternal: (url) => ipcRenderer.send('designer:open-external', url),
  getUpdate: () => ipcRenderer.invoke('designer:update-get'),
  onUpdate: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('designer:update-state', listener);
    return () => ipcRenderer.removeListener('designer:update-state', listener);
  },
  checkForUpdates: () => ipcRenderer.send('designer:update-check'),
  installUpdate: () => ipcRenderer.send('designer:update-install'),
});
