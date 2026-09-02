import { app, BrowserWindow, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  IPC,
  type AppInfo,
  type QueueAddMode,
  type QueueSnapshot,
  type ResolveResult,
} from '../shared/ipc';
import { extractVideoId } from '../shared/youtubeUrl';
import { schemaVersion } from './db';
import { LyricsService } from './lyricsService';
import { QueueService } from './queueService';
import { Repo } from './repo';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function assertVideoId(id: unknown): string {
  if (typeof id !== 'string' || !VIDEO_ID_RE.test(id)) {
    throw new Error('Invalid video id');
  }
  return id;
}

function assertInt(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error(`Invalid ${what}`);
  return n;
}

export function registerIpcHandlers(db: Database.Database, dbPath: string): void {
  const repo = new Repo(db);
  const lyrics = new LyricsService(repo);
  const queue = new QueueService(repo, lyrics, (snapshot: QueueSnapshot) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.queueChanged, snapshot);
    }
  });
  queue.init();

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    dbPath,
    schemaVersion: schemaVersion(db),
  }));

  ipcMain.handle(
    IPC.resolveVideo,
    async (_e, input: unknown, durationS: unknown): Promise<ResolveResult> => {
      if (typeof input !== 'string') throw new Error('Invalid input');
      const dur =
        typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0
          ? durationS
          : undefined;
      const result = await lyrics.resolve(input, dur);
      // The playing song's with-duration re-resolve may have found lyrics the
      // prefetch missed — keep the queue badge in step.
      if (!result.fromCache) queue.refresh(extractVideoId(input) ?? undefined);
      return result;
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
    queue.refresh();
  });

  // ── queue ──
  ipcMain.handle(IPC.queueGet, (): QueueSnapshot => queue.snapshot());

  ipcMain.handle(IPC.queueAdd, (_e, input: unknown, mode: unknown): number => {
    if (typeof input !== 'string') throw new Error('Invalid input');
    const m: QueueAddMode = mode === 'next' ? 'next' : 'end';
    return queue.add(input, m);
  });

  ipcMain.handle(IPC.queueRemove, (_e, id: unknown): void => {
    queue.remove(assertInt(id, 'queue id'));
  });

  ipcMain.handle(IPC.queueMove, (_e, id: unknown, toIndex: unknown): void => {
    queue.move(assertInt(id, 'queue id'), assertInt(toIndex, 'index'));
  });

  ipcMain.handle(IPC.queuePlay, (_e, id: unknown): void => {
    queue.play(assertInt(id, 'queue id'));
  });

  ipcMain.handle(IPC.queueAdvance, (): void => queue.advance());

  ipcMain.handle(IPC.queueClear, (): void => queue.clear());
}
