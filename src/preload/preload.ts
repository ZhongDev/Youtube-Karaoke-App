import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type KaraokeApi, type QueueSnapshot } from '../shared/ipc';

const api: KaraokeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  resolveVideo: (input, durationS) =>
    ipcRenderer.invoke(IPC.resolveVideo, input, durationS),
  setOffset: (videoId, offsetMs) =>
    ipcRenderer.invoke(IPC.setOffset, videoId, offsetMs),
  markEmbedBlocked: (videoId) => ipcRenderer.invoke(IPC.markEmbedBlocked, videoId),

  queueGet: () => ipcRenderer.invoke(IPC.queueGet),
  queueAdd: (input, mode) => ipcRenderer.invoke(IPC.queueAdd, input, mode),
  queueRemove: (id) => ipcRenderer.invoke(IPC.queueRemove, id),
  queueMove: (id, toIndex) => ipcRenderer.invoke(IPC.queueMove, id, toIndex),
  queuePlay: (id) => ipcRenderer.invoke(IPC.queuePlay, id),
  queueAdvance: () => ipcRenderer.invoke(IPC.queueAdvance),
  queueClear: () => ipcRenderer.invoke(IPC.queueClear),
  onQueueChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, snapshot: QueueSnapshot) => cb(snapshot);
    ipcRenderer.on(IPC.queueChanged, listener);
    return () => ipcRenderer.removeListener(IPC.queueChanged, listener);
  },
};

contextBridge.exposeInMainWorld('karaoke', api);
