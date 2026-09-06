// Shared IPC contract between main, preload and renderer.
// Every channel gets: a constant, typed request/response shapes, and a
// method on KaraokeApi. No `any` crosses this boundary (SPEC.md §11).

import type { Language } from './language';
export type { Language } from './language';

export interface AppInfo {
  appVersion: string;
  dbPath: string;
  schemaVersion: number;
}

export type LyricsKind = 'synced_word' | 'synced_line' | 'plain';

/** Where the artist/track pair came from; 'user' edits are never overwritten. */
export type MetaSource = 'parsed' | 'ollama' | 'user';

export interface TrackInfo {
  videoId: string;
  title: string;
  channel: string;
  artist: string | null;
  track: string | null;
  durationS: number | null;
  isTopic: boolean;
  embeddable: boolean;
  /** Detected script: en / ja / ko / other (SPEC.md §5). */
  language: Language | null;
  metaSource: MetaSource | null;
}

export interface LyricsDoc {
  source: string; // 'lrclib' | 'netease' | 'manual' | 'aligned' | …
  kind: LyricsKind;
  body: string; // raw LRC / enhanced LRC / plain text
  providerDurationS: number | null;
}

export interface ResolveResult {
  track: TrackInfo;
  /** The active document: the user's chosen source, else best by rank. */
  lyrics: LyricsDoc | null;
  /** Every stored document for this video (for the inspector). */
  sources: LyricsDoc[];
  /** User override of the active source; null = automatic (best by rank). */
  activeSource: string | null;
  offsetMs: number;
  fromCache: boolean;
  warning: string | null;
  /**
   * video length − lyrics recording length, in seconds, when it exceeds the
   * SPEC.md §8 drift threshold (3 s); null otherwise. The UI offers the
   * "Artist - Topic" upload in that case.
   */
  driftS: number | null;
}

// ── settings (SPEC.md §7) ──

export type ProviderId = 'lrclib' | 'netease';
export const PROVIDER_IDS: readonly ProviderId[] = ['lrclib', 'netease'];

export interface OllamaSettings {
  enabled: boolean;
  endpoint: string; // e.g. http://localhost:11434
  model: string; // e.g. llama3.1
}

/**
 * How synced lyrics are drawn (SPEC.md §7):
 *  - twoTrack: Joysound-style two fixed lanes in the bottom 40% of the
 *    stage, fade in/out only, left→right wipe highlight (default)
 *  - scroll: previous / current / next window
 */
export type LyricsMode = 'twoTrack' | 'scroll';
export const LYRICS_MODES: readonly LyricsMode[] = ['twoTrack', 'scroll'];

/** Reading aid drawn above the native text (extraction lands in Phase 6). */
export type RubyMode = 'none' | 'furigana' | 'romaji';
export const RUBY_MODES: readonly RubyMode[] = ['none', 'furigana', 'romaji'];

export interface DisplaySettings {
  lyricsMode: LyricsMode;
  ruby: RubyMode;
}

export interface YtDlpSettings {
  /** Explicit yt-dlp executable; '' = auto (managed copy, then PATH). */
  path: string;
}

/** Whisper checkpoints offered for alignment (SPEC.md §5: large-v3 default, medium for speed). */
export type WhisperModel = 'large-v3' | 'large-v3-turbo' | 'medium' | 'small';
export const WHISPER_MODELS: readonly WhisperModel[] = [
  'large-v3',
  'large-v3-turbo',
  'medium',
  'small',
];

/** auto = Apple GPU (MPS) when available, falling back to CPU per stage. */
export type AlignDevice = 'auto' | 'cpu';
export const ALIGN_DEVICES: readonly AlignDevice[] = ['auto', 'cpu'];

export interface AlignSettings {
  model: WhisperModel;
  device: AlignDevice;
}

export interface UvSettings {
  /** Explicit uv executable; '' = auto (managed copy, then PATH). */
  path: string;
}

export interface Settings {
  providers: Record<ProviderId, boolean>;
  ollama: OllamaSettings;
  display: DisplaySettings;
  ytdlp: YtDlpSettings;
  align: AlignSettings;
  uv: UvSettings;
}

/** Partial update; omitted fields keep their current value. */
export interface SettingsPatch {
  providers?: Partial<Record<ProviderId, boolean>>;
  ollama?: Partial<OllamaSettings>;
  display?: Partial<DisplaySettings>;
  ytdlp?: Partial<YtDlpSettings>;
  align?: Partial<AlignSettings>;
  uv?: Partial<UvSettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  providers: { lrclib: true, netease: true },
  ollama: { enabled: false, endpoint: 'http://localhost:11434', model: 'llama3.1' },
  display: { lyricsMode: 'twoTrack', ruby: 'none' },
  ytdlp: { path: '' },
  align: { model: 'large-v3', device: 'auto' },
  uv: { path: '' },
};

/** Per-item lyric state shown as a badge in the queue (SPEC.md §7). */
export type QueueLyricsState =
  | 'fetching'
  | 'synced_word'
  | 'synced_line'
  | 'plain'
  | 'none'
  | 'error'; // metadata lookup failed (bad id, private, offline)

export interface QueueItem {
  /** Stable queue row id — survives reorders and allows duplicate videos. */
  id: number;
  videoId: string;
  /** '' until oEmbed metadata has landed. */
  title: string;
  channel: string;
  artist: string | null;
  track: string | null;
  durationS: number | null;
  isTopic: boolean;
  embeddable: boolean;
  lyrics: QueueLyricsState;
}

/**
 * The whole queue, in play order. items[0] is now playing; finished and
 * skipped songs are removed from the head. `rev` increases with every change
 * so the renderer can drop stale snapshots.
 */
export interface QueueSnapshot {
  rev: number;
  items: QueueItem[];
}

export type QueueAddMode = 'end' | 'next';

// ── search & Topic suggestion (SPEC.md §7, Phase 4) ──

/** One `yt-dlp ytsearch` hit. */
export interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
  /** Auto-generated "Artist - Topic" upload: studio audio, syncs best. */
  isTopic: boolean;
  viewCount: number | null;
  /** false = an earlier play attempt found this upload blocks embedding. */
  embeddable: boolean;
}

export interface YtDlpStatus {
  available: boolean;
  /** Executable in use (or the one that failed), null when none was found. */
  path: string | null;
  version: string | null;
  origin: 'settings' | 'managed' | 'path' | null;
  /** Where the app keeps its own copy (the Download button writes here). */
  managedDir: string;
  error: string | null;
}

export interface InstallProgress {
  phase: 'download' | 'unpack' | 'verify' | 'sync' | 'done' | 'error';
  /** 0–100 within the phase (download only; others report 0 / 100). */
  percent: number;
  message: string;
}

// ── local alignment worker (SPEC.md §5 Tier 3, Phase 5) ──

export type AlignStage =
  | 'queued'
  | 'setup' // uv / Python environment check
  | 'download' // yt-dlp bestaudio
  | 'decode' // ffmpeg → wav
  | 'separate' // Demucs vocals
  | 'load' // Whisper model load (first use downloads it)
  | 'align' // stable-ts forced alignment
  | 'done'
  | 'error'
  | 'cancelled';

export interface AlignJob {
  videoId: string;
  /** Song label for status displays. */
  title: string;
  /** Lyrics source whose text was the alignment reference. */
  source: string;
  model: WhisperModel;
  stage: AlignStage;
  percent: number;
  message: string;
  error: string | null;
  warnings: string[];
  startedAt: number;
  finishedAt: number | null;
}

/** All jobs of this session, newest first. */
export interface AlignSnapshot {
  jobs: AlignJob[];
}

export interface UvStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  origin: 'settings' | 'managed' | 'path' | null;
  managedDir: string;
  /** The worker's Python environment matches worker/uv.lock. */
  envReady: boolean;
  envDir: string;
  error: string | null;
}

/** The "Artist - Topic" upload proposed for an embed-blocked / drifting video. */
export interface TopicSuggestion {
  videoId: string;
  title: string;
  channel: string;
  durationS: number | null;
}

// ── TV mode (SPEC.md §7) ──

export interface DisplayInfo {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
  /** The display the app window is on right now. */
  current: boolean;
}

export const IPC = {
  getAppInfo: 'app:get-info',
  resolveVideo: 'video:resolve',
  setOffset: 'video:set-offset',
  markEmbedBlocked: 'video:mark-embed-blocked',
  suggestTopic: 'video:suggest-topic',
  queueGet: 'queue:get',
  queueAdd: 'queue:add',
  queueReplace: 'queue:replace',
  queueRemove: 'queue:remove',
  queueMove: 'queue:move',
  queuePlay: 'queue:play',
  queueAdvance: 'queue:advance',
  queueClear: 'queue:clear',
  /** main → renderer push, payload: QueueSnapshot */
  queueChanged: 'queue:changed',
  lyricsSetActive: 'lyrics:set-active',
  lyricsSetManual: 'lyrics:set-manual',
  lyricsSetMeta: 'lyrics:set-meta',
  lyricsRefetch: 'lyrics:refetch',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  search: 'search:run',
  searchStatus: 'search:status',
  searchInstall: 'search:install',
  /** main → renderer push, payload: InstallProgress */
  searchInstallProgress: 'search:install-progress',
  alignStart: 'align:start',
  alignCancel: 'align:cancel',
  alignGet: 'align:get',
  /** main → renderer push, payload: AlignSnapshot */
  alignChanged: 'align:changed',
  uvStatus: 'align:uv-status',
  uvInstall: 'align:uv-install',
  envPrepare: 'align:env-prepare',
  /** main → renderer push, payload: InstallProgress */
  envProgress: 'align:env-progress',
  displaysList: 'window:displays',
  fullscreenGet: 'window:get-fullscreen',
  fullscreenSet: 'window:set-fullscreen',
  /** main → renderer push, payload: boolean */
  fullscreenChanged: 'window:fullscreen-changed',
} as const;

/** The API exposed on `window.karaoke` by the preload script. */
export interface KaraokeApi {
  getAppInfo(): Promise<AppInfo>;
  /**
   * URL or bare video id → metadata + best cached/fetched lyrics + offset.
   * Pass durationS once the player knows it: it tightens provider matching
   * and is stored on the track. Safe to call repeatedly (cached after the
   * first success).
   */
  resolveVideo(input: string, durationS?: number): Promise<ResolveResult>;
  setOffset(videoId: string, offsetMs: number): Promise<void>;
  markEmbedBlocked(videoId: string): Promise<void>;
  /**
   * Find the auto-generated "Artist - Topic" upload of this video's song
   * (via yt-dlp search). null when none is convincing, yt-dlp is missing, or
   * the video already is one. Cached per video for the session.
   */
  suggestTopic(videoId: string): Promise<TopicSuggestion | null>;

  // ── queue (persisted in SQLite; main is the source of truth) ──
  queueGet(): Promise<QueueSnapshot>;
  /**
   * URL or id → new queue item id. Metadata + lyrics prefetch start at once.
   * `durationS` (known from a search result) lets the prefetch match the
   * provider duration before the player has ever loaded the video.
   */
  queueAdd(input: string, mode: QueueAddMode, durationS?: number): Promise<number>;
  /** Swap the video of an existing item in place (Topic-upload suggestion). */
  queueReplace(id: number, videoId: string, durationS?: number): Promise<void>;
  queueRemove(id: number): Promise<void>;
  /** Reorder: `toIndex` is the item's final index (0 is pinned, see queueLogic). */
  queueMove(id: number, toIndex: number): Promise<void>;
  /** Jump the queue: the item becomes now-playing, the old head shifts to next. */
  queuePlay(id: number): Promise<void>;
  /** Drop now-playing (song ended / skipped); the next item becomes current. */
  queueAdvance(): Promise<void>;
  queueClear(): Promise<void>;
  /** Subscribe to queue snapshots; returns an unsubscribe function. */
  onQueueChanged(cb: (snapshot: QueueSnapshot) => void): () => void;

  // ── lyrics inspector (SPEC.md §7). Each returns the fresh ResolveResult. ──
  /** Pin the active lyrics to `source`, or null to go back to best-by-rank. */
  lyricsSetActive(videoId: string, source: string | null): Promise<ResolveResult>;
  /**
   * Store pasted text as source 'manual' (LRC vs plain is detected) and make
   * it active. Empty text removes the manual source.
   */
  lyricsSetManual(videoId: string, text: string): Promise<ResolveResult>;
  /**
   * User edit of artist/track. Provider results are discarded and fetched
   * again using exactly this pair; manual lyrics are kept.
   */
  lyricsSetMeta(videoId: string, artist: string, track: string): Promise<ResolveResult>;
  /** Discard provider results and search again (metadata unchanged). */
  lyricsRefetch(videoId: string): Promise<ResolveResult>;

  settingsGet(): Promise<Settings>;
  settingsSet(patch: SettingsPatch): Promise<Settings>;

  // ── search (yt-dlp in main; SPEC.md §7) ──
  /** `ytsearch10:<query>` → results. Rejects when yt-dlp is missing/broken. */
  search(query: string): Promise<SearchResult[]>;
  searchStatus(): Promise<YtDlpStatus>;
  /** Download the official macOS build into the app's data folder. */
  searchInstall(): Promise<YtDlpStatus>;
  onInstallProgress(cb: (p: InstallProgress) => void): () => void;

  // ── local alignment (background job; playback stays usable) ──
  /**
   * Queue a forced-alignment job using the text of lyrics `source` as the
   * reference. The result is stored as source 'aligned' (kind synced_word).
   */
  alignStart(videoId: string, source: string): Promise<AlignSnapshot>;
  alignCancel(videoId: string): Promise<AlignSnapshot>;
  alignGet(): Promise<AlignSnapshot>;
  onAlignChanged(cb: (s: AlignSnapshot) => void): () => void;
  uvStatus(): Promise<UvStatus>;
  /** Download the official uv build into the app's data folder. */
  uvInstall(): Promise<UvStatus>;
  /** `uv sync` the worker environment (torch, Demucs, Whisper — hundreds of MB). */
  envPrepare(): Promise<UvStatus>;
  onEnvProgress(cb: (p: InstallProgress) => void): () => void;

  // ── TV mode (fullscreen, optionally on a chosen display) ──
  displaysList(): Promise<DisplayInfo[]>;
  getFullscreen(): Promise<boolean>;
  setFullscreen(on: boolean, displayId?: number): Promise<void>;
  onFullscreenChanged(cb: (on: boolean) => void): () => void;
}

declare global {
  interface Window {
    karaoke: KaraokeApi;
  }
}
