const { contextBridge, ipcRenderer } = require('electron');

// The only surface the ghost window gets from the main process.
contextBridge.exposeInMainWorld('paperclip', {
  onCursor: (callback) => ipcRenderer.on('cursor', (_event, point) => callback(point)),
  onMode: (callback) => ipcRenderer.on('mode', (_event, mode) => callback(mode)),
  onMessage: (callback) => ipcRenderer.on('message', (_event, message) => callback(message)),
  setHover: (over) => ipcRenderer.send('hover', over),
  drag: (dx, dy) => ipcRenderer.send('drag', { dx, dy }),
});
