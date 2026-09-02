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

export const IPC = {
  getAppInfo: 'app:get-info',
  resolveVideo: 'video:resolve',
  setOffset: 'video:set-offset',
  markEmbedBlocked: 'video:mark-embed-blocked',
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
}

declare global {
  interface Window {
    karaoke: KaraokeApi;
  }
}
