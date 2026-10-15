const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  getHardwareId: () => ipcRenderer.invoke('get-hardware-id'),
  readLocalDb: () => ipcRenderer.invoke('db-get-all'),
  saveLocalDb: (data) => ipcRenderer.invoke('db-save-all', data),
  selectUpdatePatch: () => ipcRenderer.invoke('select-update-patch'),
  applyOnlineUpdate: (arrayBuffer) => ipcRenderer.invoke('apply-online-update', arrayBuffer),
  restartApp: () => ipcRenderer.invoke('restart-app')
});
