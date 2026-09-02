// Shared IPC contract between main, preload and renderer.
// Every channel gets: a constant, typed request/response shapes, and a
// method on KaraokeApi. No `any` crosses this boundary (SPEC.md §11).

export interface AppInfo {
  appVersion: string;
  dbPath: string;
  schemaVersion: number;
}

export type LyricsKind = 'synced_word' | 'synced_line' | 'plain';

export interface TrackInfo {
  videoId: string;
  title: string;
  channel: string;
  artist: string | null;
  track: string | null;
  durationS: number | null;
  isTopic: boolean;
  embeddable: boolean;
}

export interface LyricsDoc {
  source: string; // 'lrclib' | 'netease' | 'manual' | 'aligned' | …
  kind: LyricsKind;
  body: string; // raw LRC / enhanced LRC / plain text
  providerDurationS: number | null;
}

export interface ResolveResult {
  track: TrackInfo;
  lyrics: LyricsDoc | null;
  offsetMs: number;
  fromCache: boolean;
  warning: string | null;
}

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
}

declare global {
  interface Window {
    karaoke: KaraokeApi;
  }
}
