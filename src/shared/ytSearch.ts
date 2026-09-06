// yt-dlp search plumbing with no Electron dependency, so it is unit-tested:
//  - parseSearchJson: `yt-dlp "ytsearchN:…" -J --flat-playlist` → SearchResult[]
//  - classifyInput:   is the box text URLs/ids (add directly) or a query?
//  - pickTopicUpload: best "Artist - Topic" upload among results (SPEC.md §3,
//    §8 — Topic uploads are studio audio, so LRC files sync with ~0 offset).
//
// Learned from real output: search results attribute Topic uploads to the
// artist's official channel ("YOASOBI", not "YOASOBI - Topic" as oEmbed
// says), but their auto-generated description always starts "Provided to
// YouTube by". Both signals are checked. Searching with that phrase quoted is
// also the most reliable way to surface Topic uploads (see topicSearchQueries).

import { diceSimilarity, normalizeForMatch } from './fuzzy';
import type { SearchResult } from './ipc';
import { titleVariants } from './titleParser';
import { extractVideoId } from './youtubeUrl';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TOPIC_CHANNEL_RE = /\s-\sTopic$/;
const PROVIDED_RE = /^\s*Provided to YouTube by/i;

export function isTopicEntry(channel: string, description: string): boolean {
  return TOPIC_CHANNEL_RE.test(channel) || PROVIDED_RE.test(description);
}

// ── box input ──

export type BoxInput =
  | { kind: 'empty' }
  | { kind: 'videos'; ids: string[] }
  | { kind: 'query'; query: string };

/**
 * URLs / ids (any number, whitespace-separated) are added directly; anything
 * else is a search query. A lone bare 11-letter word ("Complicated") also
 * matches the id shape, so a single plain word is still treated as a query —
 * real ids virtually always mix case or contain digits.
 */
export function classifyInput(raw: string): BoxInput {
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  const tokens = s.split(/\s+/);
  const ids: string[] = [];
  for (const t of tokens) {
    const id = extractVideoId(t);
    if (!id) return { kind: 'query', query: s };
    ids.push(id);
  }
  if (tokens.length === 1 && looksLikeWord(tokens[0]!)) return { kind: 'query', query: s };
  return { kind: 'videos', ids };
}

function looksLikeWord(t: string): boolean {
  if (!/^[A-Za-z]+$/.test(t)) return false;
  const lower = t.toLowerCase();
  return t === lower || t === t.toUpperCase() || t === t[0]!.toUpperCase() + lower.slice(1);
}

// ── yt-dlp JSON ──

interface RawEntry {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  duration?: unknown;
  description?: unknown;
  view_count?: unknown;
  live_status?: unknown;
}

/** Parse `-J --flat-playlist` output. Malformed entries are skipped, live streams dropped. */
export function parseSearchJson(json: string): SearchResult[] {
  const doc = JSON.parse(json) as { entries?: unknown };
  const entries = Array.isArray(doc.entries) ? (doc.entries as unknown[]) : [];
  const out: SearchResult[] = [];
  for (const raw of entries) {
    const r = entryToResult(raw);
    if (r) out.push(r);
  }
  return out;
}

function entryToResult(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as RawEntry;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') return null;
  const channel =
    typeof e.channel === 'string' && e.channel
      ? e.channel
      : typeof e.uploader === 'string'
        ? e.uploader
        : '';
  const description = typeof e.description === 'string' ? e.description : '';
  const duration =
    typeof e.duration === 'number' && Number.isFinite(e.duration) && e.duration > 0
      ? Math.round(e.duration)
      : null;
  return {
    videoId: e.id,
    title: typeof e.title === 'string' ? e.title : '',
    channel,
    durationS: duration,
    isTopic: isTopicEntry(channel, description),
    viewCount: typeof e.view_count === 'number' ? e.view_count : null,
    embeddable: true,
  };
}

// ── Topic upload choice ──

export interface TopicWant {
  artist: string;
  track: string;
  excludeIds: readonly string[];
  /** Length of the recording the lyrics are timed for, when known. */
  targetDurationS: number | null;
}

export interface TopicPick {
  result: SearchResult;
  score: number;
}

/** Below this the pick is not offered — better no suggestion than a wrong song. */
const ACCEPT_SCORE = 0.7;
/** A Topic upload this far from the lyrics' recording length is a different cut. */
const MAX_DURATION_DIFF_S = 8;

const VARIANT_NOISE =
  /instrumental|karaoke|off vocal|オフボーカル|remix|\blive\b|cover|acoustic|sped up|slowed|nightcore|\bedit\b|\bmix\b|reprise|\bdemo\b|ver\.|version|\binst\b/i;

/** Search queries that surface Topic uploads, in the order worth trying. */
export function topicSearchQueries(artist: string, track: string): string[] {
  const out: string[] = [];
  if (track) out.push(`${artist} ${track} "Provided to YouTube by"`.trim());
  if (artist && track) out.push(`"${artist} - Topic" ${track}`);
  return out;
}

/**
 * Best Topic upload for the wanted song: title match dominates, then the
 * channel resembling the artist, then closeness to the target duration.
 * Instrumental / live / remix variants are penalised unless asked for.
 */
export function pickTopicUpload(results: SearchResult[], want: TopicWant): TopicPick | null {
  let best: TopicPick | null = null;
  for (const r of results) {
    if (!r.isTopic || !r.embeddable || want.excludeIds.includes(r.videoId)) continue;
    const titleSim = crossSimilarity(want.track, r.title);
    if (titleSim < 0.5) continue;

    let durationScore = 0.5;
    if (want.targetDurationS && r.durationS) {
      const diff = Math.abs(r.durationS - want.targetDurationS);
      if (diff > MAX_DURATION_DIFF_S) continue;
      durationScore = 1 - diff / (MAX_DURATION_DIFF_S + 2);
    }
    const artistScore = want.artist ? artistChannelSimilarity(want.artist, r.channel) : 0.5;

    let score = 0.55 * titleSim + 0.25 * artistScore + 0.2 * durationScore;
    if (VARIANT_NOISE.test(r.title) && !VARIANT_NOISE.test(want.track)) score -= 0.3;
    if (!best || score > best.score) best = { result: r, score };
  }
  return best && best.score >= ACCEPT_SCORE ? best : null;
}

/** Max similarity across the bracketed alt-name variants of both strings. */
function crossSimilarity(a: string, b: string): number {
  let best = 0;
  for (const va of titleVariants(a)) {
    for (const vb of titleVariants(b)) best = Math.max(best, diceSimilarity(va, vb));
  }
  return best;
}

function artistChannelSimilarity(artist: string, channel: string): number {
  const c = normalizeForMatch(channel.replace(TOPIC_CHANNEL_RE, ''));
  if (!c) return 0.5;
  let best = 0;
  // Parsed artists often carry an alt-script form: "IU(아이유)" → try "IU" and
  // "아이유" too. "IU" inside "이지금 [IU Official]" or "Rick Astley" ==
  // "Rick Astley" count as a full match.
  for (const v of titleVariants(artist)) {
    const a = normalizeForMatch(v);
    if (!a) continue;
    if (a.length >= 2 && (c.includes(a) || a.includes(c))) return 1;
    best = Math.max(best, diceSimilarity(v, channel));
  }
  return best;
}
