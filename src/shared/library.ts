// Pure library helpers: the smart playlists are derived from the songs'
// play stats, and list edits are index arithmetic — all testable without
// SQLite or React.

import type { LibrarySong } from './ipc';

/** Move the item at `from` so it ends up at index `to` (clamped). */
export function moveTo<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const out = items.filter((_, i) => i !== from);
  const clamped = Math.max(0, Math.min(to, out.length));
  out.splice(clamped, 0, items[from]!);
  return out;
}

export function songLabel(s: Pick<LibrarySong, 'artist' | 'track' | 'title' | 'videoId'>): string {
  return s.artist && s.track ? `${s.artist} — ${s.track}` : s.title || s.videoId;
}

/** Played songs, latest first. */
export function recentlyPlayed(songs: readonly LibrarySong[]): LibrarySong[] {
  return songs
    .filter((s) => s.playCount > 0 && s.lastPlayedAt)
    .sort((a, b) => (b.lastPlayedAt! > a.lastPlayedAt! ? 1 : b.lastPlayedAt! < a.lastPlayedAt! ? -1 : 0));
}

/** Played songs, most plays first (ties: latest first). */
export function mostPlayed(songs: readonly LibrarySong[]): LibrarySong[] {
  return recentlyPlayed(songs).sort((a, b) => b.playCount - a.playCount);
}

/** Every cached song, alphabetical by label. */
export function allSongs(songs: readonly LibrarySong[]): LibrarySong[] {
  return [...songs].sort((a, b) => songLabel(a).localeCompare(songLabel(b), undefined, { sensitivity: 'base' }));
}

/** Case-insensitive substring filter over label, title and channel; blank = all. */
export function filterSongs(songs: readonly LibrarySong[], query: string): LibrarySong[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...songs];
  return songs.filter((s) =>
    `${songLabel(s)}\n${s.title}\n${s.channel}`.toLowerCase().includes(q),
  );
}
