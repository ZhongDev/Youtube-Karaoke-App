import { net } from 'electron';
import { bestSimilarity, cleanTitleForSearch, titleVariants } from '../../shared/titleParser';
import { USER_AGENT } from '../metadata';
import type { LyricsProvider, LyricsQuery, LyricsResult } from './types';

// LRCLIB — primary provider (SPEC.md §5). Free, no key; be a polite client:
// descriptive User-Agent, one fetch per song ever (results are cached in
// SQLite by the lyrics service).

const BASE = 'https://lrclib.net/api';

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib ${res.status} for ${url}`);
  return res.json();
}

// Community DB — troll/junk records exist (e.g. a 1-line "*Rickrolling*"
// entry that exactly matches the real duration). A synced record with
// absurdly few timed lines for its length is discarded so the ranked search
// can pick a real one instead.
function isJunkSynced(rec: LrclibRecord): boolean {
  if (!rec.syncedLyrics?.trim()) return false;
  const timedLines = rec.syncedLyrics
    .split('\n')
    .filter((l) => /\[\d/.test(l) && l.replace(/\[[^\]]*\]/g, '').trim()).length;
  const durS = rec.duration ?? 180;
  return timedLines < Math.max(4, Math.min(durS / 60, 10));
}

function durationScore(wantS: number | undefined, gotS: number | null): number {
  if (!wantS || !gotS) return 0.05;
  const d = Math.abs(wantS - gotS);
  if (d <= 2) return 0.3; // lrclib itself matches within ±2s
  if (d <= 5) return 0.15;
  if (d <= 10) return 0;
  return -0.25;
}

/**
 * (track, artist) pairs to try in order: as given, then progressively
 * simplified forms, finally the main track name alone. At most 4 requests
 * on a total miss; one on the usual hit.
 */
function fieldedAttempts(tracks: string[], artists: string[]): Array<[string, string]> {
  if (!tracks.length) return [];
  const pick = (arr: string[], i: number) => arr[Math.min(i, arr.length - 1)] ?? '';
  const out: Array<[string, string]> = [];
  const n = Math.max(tracks.length, artists.length);
  for (let i = 0; i < n; i++) out.push([pick(tracks, i), pick(artists, i)]);
  if (tracks.length > 1) out.push([tracks[1]!, '']);
  return out.filter(([t, a], i) => out.findIndex(([t2, a2]) => t2 === t && a2 === a) === i);
}

export class LrclibProvider implements LyricsProvider {
  id = 'lrclib';

  async search(q: LyricsQuery): Promise<LyricsResult[]> {
    const byId = new Map<number, { rec: LrclibRecord; confidence: number }>();

    // 1) Exact match — duration-validated, so only when duration is known.
    if (q.track && q.durationS) {
      const params = new URLSearchParams({
        track_name: q.track,
        artist_name: q.artist,
        duration: String(Math.round(q.durationS)),
      });
      const rec = (await fetchJson(`${BASE}/get?${params}`)) as LrclibRecord | null;
      if (rec && !rec.instrumental && !isJunkSynced(rec)) {
        byId.set(rec.id, { rec, confidence: 1 });
      }
    }

    // 2) Fielded search — "Blueming(블루밍)" style names are retried with
    //    their bracket-free / alt-script forms — then 3) raw-title q=
    //    fallback; rank ourselves.
    const trackVariants = titleVariants(q.track);
    const artistVariants = titleVariants(q.artist);
    let records: LrclibRecord[] = [];
    for (const [track, artist] of fieldedAttempts(trackVariants, artistVariants)) {
      const params = new URLSearchParams({ track_name: track });
      if (artist) params.set('artist_name', artist);
      records = ((await fetchJson(`${BASE}/search?${params}`)) ?? []) as LrclibRecord[];
      if (records.length) break;
    }
    if (!records.length) {
      const qText = cleanTitleForSearch(q.rawTitle);
      if (qText) {
        const params = new URLSearchParams({ q: qText });
        records = ((await fetchJson(`${BASE}/search?${params}`)) ?? []) as LrclibRecord[];
      }
    }

    const wantTrack = trackVariants.length ? trackVariants : [cleanTitleForSearch(q.rawTitle)];
    for (const rec of records) {
      if (rec.instrumental || byId.has(rec.id) || isJunkSynced(rec)) continue;
      const direct =
        0.55 * bestSimilarity(wantTrack, rec.trackName) +
        0.25 * (q.artist ? bestSimilarity(artistVariants, rec.artistName) : 0.5);
      // Community records sometimes have artist/track swapped (seen on
      // "Title - Artist" style uploads); accept those at a small penalty.
      const swapped = q.artist
        ? 0.9 *
          (0.55 * bestSimilarity(wantTrack, rec.artistName) +
            0.25 * bestSimilarity(artistVariants, rec.trackName))
        : 0;
      const score = Math.max(direct, swapped) + durationScore(q.durationS, rec.duration);
      if (score >= 0.45) byId.set(rec.id, { rec, confidence: Math.min(score, 0.99) });
    }

    const out: LyricsResult[] = [];
    for (const { rec, confidence } of byId.values()) {
      const common = {
        confidence,
        providerTrackName: rec.trackName,
        providerArtist: rec.artistName,
        ...(rec.duration ? { providerDurationS: Math.round(rec.duration) } : {}),
      };
      if (rec.syncedLyrics?.trim()) {
        out.push({ kind: 'synced_line', body: rec.syncedLyrics, ...common });
      } else if (rec.plainLyrics?.trim()) {
        out.push({
          kind: 'plain',
          body: rec.plainLyrics,
          ...common,
          confidence: confidence * 0.9,
        });
      }
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }
}
