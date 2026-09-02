import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo, type KaraokeApi } from '../shared/ipc';

const api: KaraokeApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.getAppInfo),
};

contextBridge.exposeInMainWorld('karaoke', api);
