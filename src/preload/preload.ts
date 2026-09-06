import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AlignSnapshot,
  type InstallProgress,
  type KaraokeApi,
  type QueueSnapshot,
} from '../shared/ipc';

/** Subscribe to a main → renderer push channel; returns the unsubscribe. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KaraokeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  resolveVideo: (input, durationS) =>
    ipcRenderer.invoke(IPC.resolveVideo, input, durationS),
  setOffset: (videoId, offsetMs) =>
    ipcRenderer.invoke(IPC.setOffset, videoId, offsetMs),
  markEmbedBlocked: (videoId) => ipcRenderer.invoke(IPC.markEmbedBlocked, videoId),
  suggestTopic: (videoId) => ipcRenderer.invoke(IPC.suggestTopic, videoId),

  queueGet: () => ipcRenderer.invoke(IPC.queueGet),
  queueAdd: (input, mode, durationS) =>
    ipcRenderer.invoke(IPC.queueAdd, input, mode, durationS),
  queueReplace: (id, videoId, durationS) =>
    ipcRenderer.invoke(IPC.queueReplace, id, videoId, durationS),
  queueRemove: (id) => ipcRenderer.invoke(IPC.queueRemove, id),
  queueMove: (id, toIndex) => ipcRenderer.invoke(IPC.queueMove, id, toIndex),
  queuePlay: (id) => ipcRenderer.invoke(IPC.queuePlay, id),
  queueAdvance: () => ipcRenderer.invoke(IPC.queueAdvance),
  queueClear: () => ipcRenderer.invoke(IPC.queueClear),
  onQueueChanged: (cb) => on<QueueSnapshot>(IPC.queueChanged, cb),

  lyricsSetActive: (videoId, source) =>
    ipcRenderer.invoke(IPC.lyricsSetActive, videoId, source),
  lyricsSetManual: (videoId, text) => ipcRenderer.invoke(IPC.lyricsSetManual, videoId, text),
  lyricsSetMeta: (videoId, artist, track) =>
    ipcRenderer.invoke(IPC.lyricsSetMeta, videoId, artist, track),
  lyricsRefetch: (videoId) => ipcRenderer.invoke(IPC.lyricsRefetch, videoId),

  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),

  search: (query) => ipcRenderer.invoke(IPC.search, query),
  searchStatus: () => ipcRenderer.invoke(IPC.searchStatus),
  searchInstall: () => ipcRenderer.invoke(IPC.searchInstall),
  onInstallProgress: (cb) => on<InstallProgress>(IPC.searchInstallProgress, cb),

  alignStart: (videoId, source) => ipcRenderer.invoke(IPC.alignStart, videoId, source),
  alignCancel: (videoId) => ipcRenderer.invoke(IPC.alignCancel, videoId),
  alignGet: () => ipcRenderer.invoke(IPC.alignGet),
  onAlignChanged: (cb) => on<AlignSnapshot>(IPC.alignChanged, cb),
  uvStatus: () => ipcRenderer.invoke(IPC.uvStatus),
  uvInstall: () => ipcRenderer.invoke(IPC.uvInstall),
  envPrepare: () => ipcRenderer.invoke(IPC.envPrepare),
  onEnvProgress: (cb) => on<InstallProgress>(IPC.envProgress, cb),

  displaysList: () => ipcRenderer.invoke(IPC.displaysList),
  getFullscreen: () => ipcRenderer.invoke(IPC.fullscreenGet),
  setFullscreen: (on_, displayId) => ipcRenderer.invoke(IPC.fullscreenSet, on_, displayId),
  onFullscreenChanged: (cb) => on<boolean>(IPC.fullscreenChanged, cb),
};

contextBridge.exposeInMainWorld('karaoke', api);
