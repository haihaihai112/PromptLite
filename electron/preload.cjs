const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, argument) => ipcRenderer.invoke(`promptlite:${channel}`, argument);
contextBridge.exposeInMainWorld('promptlite', {
  load: () => invoke('load'),
  saveModel: model => invoke('model-save', model),
  deleteModel: id => invoke('model-delete', id),
  saveHistory: entry => invoke('history-save', entry),
  deleteHistory: id => invoke('history-delete', id),
  saveFavorite: entry => invoke('favorite-save', entry),
  deleteFavorite: id => invoke('favorite-delete', id),
  run: request => invoke('run', request),
  cancel: id => invoke('cancel', id),
  exportBackup: () => invoke('backup-export'),
  importBackup: () => invoke('backup-import'),
  copy: text => invoke('copy', text),
  onDelta: listener => {
    const handler = (_event, delta) => listener(delta);
    ipcRenderer.on('promptlite:delta', handler);
    return () => ipcRenderer.removeListener('promptlite:delta', handler);
  }
});
