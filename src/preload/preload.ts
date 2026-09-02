import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KaraokeApi } from '../shared/ipc';

const api: KaraokeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  resolveVideo: (input, durationS) =>
    ipcRenderer.invoke(IPC.resolveVideo, input, durationS),
  setOffset: (videoId, offsetMs) =>
    ipcRenderer.invoke(IPC.setOffset, videoId, offsetMs),
  markEmbedBlocked: (videoId) => ipcRenderer.invoke(IPC.markEmbedBlocked, videoId),
};

contextBridge.exposeInMainWorld('karaoke', api);
