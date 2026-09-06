import { describe, expect, it } from 'vitest';
import type { LibrarySong } from './ipc';
import { allSongs, filterSongs, mostPlayed, moveTo, recentlyPlayed, songLabel } from './library';

const S = (videoId: string, o: Partial<LibrarySong> = {}): LibrarySong => ({
  videoId,
  title: `title ${videoId}`,
  channel: 'ch',
  artist: null,
  track: null,
  durationS: null,
  isTopic: false,
  embeddable: true,
  lyrics: 'none',
  playCount: 0,
  lastPlayedAt: null,
  addedAt: '2026-09-01 00:00:00',
  ...o,
});

describe('moveTo', () => {
  it('moves forward and backward, clamping the target', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveTo(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
    expect(moveTo(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('smart playlists', () => {
  const songs = [
    S('x', { playCount: 3, lastPlayedAt: '2026-09-05 10:00:00', artist: 'IU', track: 'Blueming' }),
    S('y', { playCount: 1, lastPlayedAt: '2026-09-06 09:00:00', title: 'Zebra' }),
    S('z', { playCount: 0, title: 'Alpha' }),
    S('w', { playCount: 3, lastPlayedAt: '2026-09-06 12:00:00', title: 'Marigold' }),
  ];

  it('recentlyPlayed: played only, latest first', () => {
    expect(recentlyPlayed(songs).map((s) => s.videoId)).toEqual(['w', 'y', 'x']);
  });

  it('mostPlayed: by count, ties latest first', () => {
    expect(mostPlayed(songs).map((s) => s.videoId)).toEqual(['w', 'x', 'y']);
  });

  it('allSongs: alphabetical by label', () => {
    expect(allSongs(songs).map((s) => s.videoId)).toEqual(['z', 'x', 'w', 'y']);
  });

  it('songLabel and filterSongs', () => {
    expect(songLabel(songs[0]!)).toBe('IU — Blueming');
    expect(songLabel(songs[1]!)).toBe('Zebra');
    expect(filterSongs(songs, 'blue').map((s) => s.videoId)).toEqual(['x']);
    expect(filterSongs(songs, '  ').length).toBe(4);
    expect(filterSongs(songs, 'CH').length).toBe(4); // channel matches too
  });
});
