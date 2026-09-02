import type { LyricsKind } from '../../shared/ipc';

// Pluggable lyrics-provider layer (SPEC.md §5). Unofficial providers break
// and get swapped out — keep everything behind this interface.

export interface LyricsQuery {
  artist: string;
  track: string;
  album?: string;
  durationS?: number;
  rawTitle: string;
  language?: string;
}

export interface LyricsResult {
  kind: LyricsKind;
  body: string;
  confidence: number; // 0..1, provider's own ranking
  providerTrackName: string;
  providerArtist: string;
  providerDurationS?: number;
}

export interface LyricsProvider {
  id: string;
  search(q: LyricsQuery): Promise<LyricsResult[]>;
}
