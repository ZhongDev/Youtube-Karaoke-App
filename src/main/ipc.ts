import { app, BrowserWindow, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  IPC,
  LYRICS_MODES,
  PROVIDER_IDS,
  RUBY_MODES,
  type AppInfo,
  type LyricsMode,
  type QueueAddMode,
  type QueueSnapshot,
  type ResolveResult,
  type RubyMode,
  type Settings,
  type SettingsPatch,
} from '../shared/ipc';
import { extractVideoId } from '../shared/youtubeUrl';
import { schemaVersion } from './db';
import { LyricsService } from './lyricsService';
import { QueueService } from './queueService';
import { Repo } from './repo';
import { SettingsStore } from './settings';

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

function assertText(v: unknown, what: string, maxLen: number): string {
  if (typeof v !== 'string' || v.length > maxLen) throw new Error(`Invalid ${what}`);
  return v;
}

/** Keep only well-typed, known keys of a settings patch from the renderer. */
function sanitizeSettingsPatch(raw: unknown): SettingsPatch {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid settings patch');
  const r = raw as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (r['providers'] && typeof r['providers'] === 'object') {
    const p = r['providers'] as Record<string, unknown>;
    patch.providers = {};
    for (const id of PROVIDER_IDS) {
      if (typeof p[id] === 'boolean') patch.providers[id] = p[id];
    }
  }
  if (r['ollama'] && typeof r['ollama'] === 'object') {
    const o = r['ollama'] as Record<string, unknown>;
    patch.ollama = {};
    if (typeof o['enabled'] === 'boolean') patch.ollama.enabled = o['enabled'];
    if (typeof o['endpoint'] === 'string' && /^https?:\/\/\S+$/.test(o['endpoint'].trim())) {
      patch.ollama.endpoint = o['endpoint'];
    }
    if (typeof o['model'] === 'string' && o['model'].trim()) patch.ollama.model = o['model'];
  }
  if (r['display'] && typeof r['display'] === 'object') {
    const d = r['display'] as Record<string, unknown>;
    patch.display = {};
    if ((LYRICS_MODES as readonly unknown[]).includes(d['lyricsMode'])) {
      patch.display.lyricsMode = d['lyricsMode'] as LyricsMode;
    }
    if ((RUBY_MODES as readonly unknown[]).includes(d['ruby'])) {
      patch.display.ruby = d['ruby'] as RubyMode;
    }
  }
  return patch;
}

export function registerIpcHandlers(db: Database.Database, dbPath: string): void {
  const repo = new Repo(db);
  const settings = new SettingsStore(db);
  const lyrics = new LyricsService(repo, settings);
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

  // ── lyrics inspector ──
  ipcMain.handle(
    IPC.lyricsSetActive,
    (_e, videoId: unknown, source: unknown): ResolveResult => {
      const id = assertVideoId(videoId);
      const src = source === null ? null : assertText(source, 'source', 64);
      const r = lyrics.setActive(id, src);
      queue.refresh(id);
      return r;
    },
  );

  ipcMain.handle(IPC.lyricsSetManual, (_e, videoId: unknown, text: unknown): ResolveResult => {
    const id = assertVideoId(videoId);
    const r = lyrics.setManual(id, assertText(text, 'lyrics text', 200_000));
    queue.refresh(id);
    return r;
  });

  ipcMain.handle(
    IPC.lyricsSetMeta,
    async (_e, videoId: unknown, artist: unknown, track: unknown): Promise<ResolveResult> => {
      const id = assertVideoId(videoId);
      const r = await lyrics.setMeta(
        id,
        assertText(artist, 'artist', 300),
        assertText(track, 'track', 300),
      );
      queue.refresh(id);
      return r;
    },
  );

  ipcMain.handle(IPC.lyricsRefetch, async (_e, videoId: unknown): Promise<ResolveResult> => {
    const id = assertVideoId(videoId);
    const r = await lyrics.refetch(id);
    queue.refresh(id);
    return r;
  });

  // ── settings ──
  ipcMain.handle(IPC.settingsGet, (): Settings => settings.get());

  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown): Settings => {
    const s = settings.set(sanitizeSettingsPatch(patch));
    console.log('[settings] updated:', JSON.stringify(s));
    return s;
  });
}
