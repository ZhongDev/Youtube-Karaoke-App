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

export interface Settings {
  providers: Record<ProviderId, boolean>;
  ollama: OllamaSettings;
  display: DisplaySettings;
}

/** Partial update; omitted fields keep their current value. */
export interface SettingsPatch {
  providers?: Partial<Record<ProviderId, boolean>>;
  ollama?: Partial<OllamaSettings>;
  display?: Partial<DisplaySettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  providers: { lrclib: true, netease: true },
  ollama: { enabled: false, endpoint: 'http://localhost:11434', model: 'llama3.1' },
  display: { lyricsMode: 'twoTrack', ruby: 'none' },
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

export const IPC = {
  getAppInfo: 'app:get-info',
  resolveVideo: 'video:resolve',
  setOffset: 'video:set-offset',
  markEmbedBlocked: 'video:mark-embed-blocked',
  queueGet: 'queue:get',
  queueAdd: 'queue:add',
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

  // ── queue (persisted in SQLite; main is the source of truth) ──
  queueGet(): Promise<QueueSnapshot>;
  /** URL or id → new queue item id. Metadata + lyrics prefetch start at once. */
  queueAdd(input: string, mode: QueueAddMode): Promise<number>;
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
}

declare global {
  interface Window {
    karaoke: KaraokeApi;
  }
}
