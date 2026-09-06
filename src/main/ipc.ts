import { app, BrowserWindow, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  ALIGN_DEVICES,
  IPC,
  LYRICS_MODES,
  PROVIDER_IDS,
  RUBY_MODES,
  WHISPER_MODELS,
  type AlignDevice,
  type AlignSnapshot,
  type AppInfo,
  type DisplayInfo,
  type LyricsMode,
  type QueueAddMode,
  type QueueSnapshot,
  type ResolveResult,
  type RubyMode,
  type SearchResult,
  type Settings,
  type SettingsPatch,
  type TopicSuggestion,
  type UvStatus,
  type WhisperModel,
  type YtDlpStatus,
} from '../shared/ipc';
import { extractVideoId } from '../shared/youtubeUrl';
import { AlignService } from './alignService';
import { schemaVersion } from './db';
import { LyricsService } from './lyricsService';
import { QueueService } from './queueService';
import { Repo } from './repo';
import { SettingsStore } from './settings';
import { TopicSuggester } from './topicSuggest';
import { Uv } from './uv';
import { listDisplays, setFullscreen } from './window';
import { YtDlp } from './ytdlp';

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

/** Optional positive duration in seconds; anything else → undefined. */
function optDuration(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
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
  if (r['ytdlp'] && typeof r['ytdlp'] === 'object') {
    const y = r['ytdlp'] as Record<string, unknown>;
    if (typeof y['path'] === 'string' && y['path'].length <= 1000) {
      patch.ytdlp = { path: y['path'] };
    }
  }
  if (r['align'] && typeof r['align'] === 'object') {
    const a = r['align'] as Record<string, unknown>;
    patch.align = {};
    if ((WHISPER_MODELS as readonly unknown[]).includes(a['model'])) {
      patch.align.model = a['model'] as WhisperModel;
    }
    if ((ALIGN_DEVICES as readonly unknown[]).includes(a['device'])) {
      patch.align.device = a['device'] as AlignDevice;
    }
  }
  if (r['uv'] && typeof r['uv'] === 'object') {
    const u = r['uv'] as Record<string, unknown>;
    if (typeof u['path'] === 'string' && u['path'].length <= 1000) patch.uv = { path: u['path'] };
  }
  return patch;
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(db: Database.Database, dbPath: string): void {
  const repo = new Repo(db);
  const settings = new SettingsStore(db);
  const lyrics = new LyricsService(repo, settings);
  const queue = new QueueService(repo, lyrics, (snapshot: QueueSnapshot) =>
    broadcast(IPC.queueChanged, snapshot),
  );
  queue.init();
  const ytdlp = new YtDlp(settings, (p) => broadcast(IPC.searchInstallProgress, p));
  const topics = new TopicSuggester(repo, ytdlp);
  const uv = new Uv(settings, (p) => broadcast(IPC.envProgress, p));
  const align = new AlignService(
    repo,
    settings,
    uv,
    ytdlp,
    (s) => broadcast(IPC.alignChanged, s),
    (videoId) => queue.refresh(videoId),
  );
  app.on('before-quit', () => align.shutdown());

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    dbPath,
    schemaVersion: schemaVersion(db),
  }));

  ipcMain.handle(
    IPC.resolveVideo,
    async (_e, input: unknown, durationS: unknown): Promise<ResolveResult> => {
      if (typeof input !== 'string') throw new Error('Invalid input');
      const result = await lyrics.resolve(input, optDuration(durationS));
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

  ipcMain.handle(
    IPC.suggestTopic,
    (_e, videoId: unknown): Promise<TopicSuggestion | null> =>
      topics.suggest(assertVideoId(videoId)),
  );

  // ── queue ──
  ipcMain.handle(IPC.queueGet, (): QueueSnapshot => queue.snapshot());

  ipcMain.handle(
    IPC.queueAdd,
    (_e, input: unknown, mode: unknown, durationS: unknown): number => {
      if (typeof input !== 'string') throw new Error('Invalid input');
      const m: QueueAddMode = mode === 'next' ? 'next' : 'end';
      return queue.add(input, m, optDuration(durationS));
    },
  );

  ipcMain.handle(
    IPC.queueReplace,
    (_e, id: unknown, videoId: unknown, durationS: unknown): void => {
      queue.replace(assertInt(id, 'queue id'), assertVideoId(videoId), optDuration(durationS));
    },
  );

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

  // ── search (yt-dlp) ──
  ipcMain.handle(IPC.search, async (_e, query: unknown): Promise<SearchResult[]> => {
    const q = assertText(query, 'query', 200).trim();
    if (!q) return [];
    const results = await ytdlp.search(q);
    // Flag uploads that blocked embedding on an earlier attempt.
    return results.map((r) => ({
      ...r,
      embeddable: repo.getTrack(r.videoId)?.embeddable !== 0,
    }));
  });

  ipcMain.handle(IPC.searchStatus, (): Promise<YtDlpStatus> => ytdlp.status());

  ipcMain.handle(IPC.searchInstall, (): Promise<YtDlpStatus> => ytdlp.install());

  // ── local alignment ──
  ipcMain.handle(IPC.alignStart, (_e, videoId: unknown, source: unknown): AlignSnapshot => {
    return align.start(assertVideoId(videoId), assertText(source, 'source', 64));
  });

  ipcMain.handle(IPC.alignCancel, (_e, videoId: unknown): AlignSnapshot => {
    return align.cancel(assertVideoId(videoId));
  });

  ipcMain.handle(IPC.alignGet, (): AlignSnapshot => align.snapshot());

  ipcMain.handle(IPC.uvStatus, (): Promise<UvStatus> => uv.status());

  ipcMain.handle(IPC.uvInstall, (): Promise<UvStatus> => uv.install());

  ipcMain.handle(IPC.envPrepare, (): Promise<UvStatus> => uv.prepareEnv());

  // ── TV mode ──
  ipcMain.handle(IPC.displaysList, (e): DisplayInfo[] => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? listDisplays(win) : [];
  });

  ipcMain.handle(
    IPC.fullscreenGet,
    (e): boolean => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false,
  );

  ipcMain.handle(
    IPC.fullscreenSet,
    async (e, on: unknown, displayId: unknown): Promise<void> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      if (typeof on !== 'boolean') throw new Error('Invalid fullscreen flag');
      const d = typeof displayId === 'number' && Number.isInteger(displayId) ? displayId : undefined;
      await setFullscreen(win, on, d);
    },
  );
}
