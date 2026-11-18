const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('designerNative', {
  isElectron: true,
  pickFolder: () => ipcRenderer.invoke('designer:pick-folder'),
  openExternal: (url) => ipcRenderer.send('designer:open-external', url),
});
