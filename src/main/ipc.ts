import { app, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { IPC, type AppInfo, type ResolveResult } from '../shared/ipc';
import { schemaVersion } from './db';
import { LyricsService } from './lyricsService';
import { Repo } from './repo';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function assertVideoId(id: unknown): string {
  if (typeof id !== 'string' || !VIDEO_ID_RE.test(id)) {
    throw new Error('Invalid video id');
  }
  return id;
}

export function registerIpcHandlers(db: Database.Database, dbPath: string): void {
  const repo = new Repo(db);
  const lyrics = new LyricsService(repo);

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    dbPath,
    schemaVersion: schemaVersion(db),
  }));

  ipcMain.handle(
    IPC.resolveVideo,
    (_e, input: unknown, durationS: unknown): Promise<ResolveResult> => {
      if (typeof input !== 'string') throw new Error('Invalid input');
      const dur =
        typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0
          ? durationS
          : undefined;
      return lyrics.resolve(input, dur);
    },
  );

  ipcMain.handle(IPC.setOffset, (_e, videoId: unknown, offsetMs: unknown): void => {
    const id = assertVideoId(videoId);
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) {
      throw new Error('Invalid offset');
    }
    repo.setOffset(id, offsetMs);
  });

  ipcMain.handle(IPC.markEmbedBlocked, (_e, videoId: unknown): void => {
    repo.setEmbeddable(assertVideoId(videoId), false);
  });
}
