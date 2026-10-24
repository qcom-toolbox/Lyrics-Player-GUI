const { contextBridge, ipcRenderer } = require('electron');

// The small slice of the main process the page is allowed to reach.
contextBridge.exposeInMainWorld('pearLyrics', {
  getGpuStatus: () => ipcRenderer.invoke('gpu:get-status'),
  setGpuEnabled: (enabled, restartNow) => ipcRenderer.invoke('gpu:set-enabled', enabled, restartNow),
});
