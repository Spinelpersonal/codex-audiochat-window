import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent, OverlayAPI } from '../shared/types';

const api: OverlayAPI = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  testCli: () => ipcRenderer.invoke('codex:test'),
  newConversation: mode => ipcRenderer.invoke('chat:new', mode),
  deleteConversation: id => ipcRenderer.invoke('chat:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
  exportConversation: id => ipcRenderer.invoke('chat:export', id),
  send: input => ipcRenderer.invoke('chat:send', input),
  cancel: id => ipcRenderer.invoke('chat:cancel', id),
  capture: mode => ipcRenderer.invoke('capture:start', mode),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  dropFiles: files => {
    const paths = files.map(file => webUtils.getPathForFile(file));
    return ipcRenderer.invoke('files:drop', paths);
  },
  releaseAttachments: ids => ipcRenderer.invoke('files:release', ids),
  copy: text => ipcRenderer.invoke('clipboard:copy', text),
  speak: text => ipcRenderer.invoke('audio:speak', text),
  stopSpeech: () => ipcRenderer.invoke('audio:stop'),
  voices: () => ipcRenderer.invoke('audio:voices'),
  selectDirectory: () => ipcRenderer.invoke('dialog:directory'),
  selectCli: () => ipcRenderer.invoke('dialog:cli'),
  windowAction: action => ipcRenderer.invoke('window:action', action),
  onEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: AppEvent) => callback(event);
    ipcRenderer.on('overlay:event', listener);
    return () => { ipcRenderer.removeListener('overlay:event', listener); };
  },
};
contextBridge.exposeInMainWorld('overlay', Object.freeze(api));
