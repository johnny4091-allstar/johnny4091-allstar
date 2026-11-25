// The only thing the Aurora page gets from the Windows app: who it is and a way to ask for updates.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('AuroraDesktop', {
  platform: 'windows',
  version: ipcRenderer.sendSync('aurora:version'),
  checkForUpdates: () => ipcRenderer.invoke('aurora:check-update'),
});
