const { contextBridge, ipcRenderer } = require('electron');

// The small slice of the main process the page is allowed to reach.
contextBridge.exposeInMainWorld('pearLyrics', {
  getRenderStatus: () => ipcRenderer.invoke('render:get-status'),
  setRenderSetting: (key, enabled, restartNow) => ipcRenderer.invoke('render:set', key, enabled, restartNow),
  enableLinuxSystemAudio: () => ipcRenderer.invoke('audio:enable-linux-system-audio'),
});
