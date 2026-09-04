import { net } from 'electron';
import { bestSimilarity, cleanTitleForSearch, titleVariants } from '../../shared/titleParser';
import { USER_AGENT } from '../metadata';
import { cleanNeteaseLrc } from './neteaseLrc';
import type { LyricsProvider, LyricsQuery, LyricsResult } from './types';

// NetEase Cloud Music — huge CJK library, unofficial endpoints (SPEC.md §5,
// §8: isolate, timeout, degrade). Search is done in the original script;
// the lyrics service passes parsed artist/track as-is. Any failure throws
// and the service moves on to the next provider.

const BASE = 'https://music.163.com/api';
const TIMEOUT_MS = 5000;
/** Lyric fetches per search — the top few ranked hits are enough. */
const MAX_LYRIC_FETCHES = 3;

interface NeteaseSong {
  id: number;
  name: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  duration?: number; // ms
}

interface SearchReply {
  code?: number;
  result?: { songs?: NeteaseSong[] };
}

interface LyricReply {
  code?: number;
  nolyric?: boolean;
  uncollected?: boolean;
  lrc?: { lyric?: string | null };
}

async function fetchJson(url: string): Promise<unknown> {
  // credentials: 'omit' — NetEase answers with decoy "hot" results once its
  // NMTID cookie is echoed back by a non-browser client (verified: the same
  // search with vs without the cookie). Never send or store its cookies.
  const res = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://music.163.com/' },
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`netease ${res.status} for ${url}`);
  return res.json();
}

function durationScore(wantS: number | undefined, gotMs: number | undefined): number {
  if (!wantS || !gotMs) return 0.05;
  const d = Math.abs(wantS - gotMs / 1000);
  if (d <= 2) return 0.3;
  if (d <= 5) return 0.15;
  if (d <= 10) return 0;
  return -0.25;
}

/**
 * Unsynced lyrics on NetEase are uploaded with every line stamped
 * [00:00.00] (or a couple of distinct stamps). Treat those as plain text.
 */
function isEffectivelyUntimed(lrc: string): boolean {
  const stamps = new Set<string>();
  for (const m of lrc.matchAll(/\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g)) stamps.add(m[1]!);
  return stamps.size < 3;
}

function stripTimestamps(lrc: string): string {
  return lrc
    .split('\n')
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

export class NeteaseProvider implements LyricsProvider {
  id = 'netease';

  async search(q: LyricsQuery): Promise<LyricsResult[]> {
    const trackVariants = titleVariants(q.track);
    const artistVariants = titleVariants(q.artist);
    const wantTrack = trackVariants.length ? trackVariants : [cleanTitleForSearch(q.rawTitle)];

    // Free-text queries: as parsed, then the simplified / alt-script forms.
    const pick = (arr: string[], i: number) => arr[Math.min(i, arr.length - 1)] ?? '';
    const queries: string[] = [];
    for (let i = 0; i < Math.max(trackVariants.length, artistVariants.length, 1); i++) {
      const text = `${pick(artistVariants, i)} ${pick(trackVariants, i)}`.trim();
      if (text && !queries.includes(text)) queries.push(text);
    }
    if (!queries.length) {
      const raw = cleanTitleForSearch(q.rawTitle);
      if (raw) queries.push(raw);
    }

    type Hit = { song: NeteaseSong; artistNames: string; confidence: number };
    let ranked: Hit[] = [];
    for (const query of queries) {
      const params = new URLSearchParams({ s: query, type: '1', limit: '10' });
      const reply = (await fetchJson(`${BASE}/search/get?${params}`)) as SearchReply;
      const songs = reply.result?.songs ?? [];
      ranked = songs
        .filter((s) => typeof s.id === 'number' && typeof s.name === 'string')
        .map((song) => {
          const artistNames = (song.artists ?? []).map((a) => a.name ?? '').join(' ');
          const score =
            0.55 * bestSimilarity(wantTrack, song.name) +
            0.25 * (q.artist ? bestSimilarity(artistVariants, artistNames) : 0.5) +
            durationScore(q.durationS, song.duration);
          return { song, artistNames, confidence: Math.min(score, 0.99) };
        })
        .filter((r) => r.confidence >= 0.45)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_LYRIC_FETCHES);
      const top = ranked[0];
      console.log(
        `[netease] "${query}" → ${songs.length} songs, ${ranked.length} usable` +
          (top ? ` (top: ${top.song.name} / ${top.artistNames} @${top.confidence.toFixed(2)})` : ''),
      );
      if (ranked.length) break;
    }

    const out: LyricsResult[] = [];
    for (const { song, artistNames, confidence } of ranked) {
      const lp = new URLSearchParams({ id: String(song.id), lv: '1', kv: '1', tv: '-1' });
      const lyr = (await fetchJson(`${BASE}/song/lyric?${lp}`)) as LyricReply;
      if (lyr.nolyric || lyr.uncollected) {
        console.log(`[netease] song ${song.id}: no lyrics`);
        continue;
      }
      const body = cleanNeteaseLrc(lyr.lrc?.lyric);
      if (!body) {
        console.log(`[netease] song ${song.id}: empty/instrumental body`);
        continue;
      }

      const common = {
        confidence,
        providerTrackName: song.name,
        providerArtist: artistNames,
        ...(song.duration ? { providerDurationS: Math.round(song.duration / 1000) } : {}),
      };
      if (isEffectivelyUntimed(body)) {
        out.push({ kind: 'plain', body: stripTimestamps(body), ...common, confidence: confidence * 0.9 });
        continue;
      }
      out.push({ kind: 'synced_line', body, ...common });
      break; // the service takes the first synced hit; don't spend more requests
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }
}
