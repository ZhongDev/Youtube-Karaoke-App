// Auto-offset estimation (SPEC.md Phase 6): Whisper transcribes the opening
// stretch of the video's isolated vocals; the first lyric lines are looked
// for in what it heard, and where they are versus where the LRC says they
// are = the intro-length difference = the per-video offset. (Forced
// alignment of a short text against audio with a long silent intro proved
// unreliable; free transcription times what is actually sung.) The worker
// does the audio work; the pure parts — which lines to look for, how much
// audio to fetch, how to read the answer — live here so they can be tested.

import { diceSimilarity } from './fuzzy';
import type { LrcLine } from './lrc';
import { kataToHira } from './ruby';

/** Credit lines some providers time at 0 s (作詞 / 作曲 / Lyrics: …) are never sung. */
const CREDIT_RE =
  /^(作詞|作曲|編曲|作词|词|曲|歌手|演唱|唱|lyrics?|lyricist|composer|composed|music|arranger?|arranged|producer|produced|vocals?)\s*[:：/／]/iu;

/** Lines within this much of the first line are aligned too (anchors the fit). */
export const PROBE_SPAN_MS = 30_000;
export const PROBE_MAX_LINES = 12;
/** Largest intro-length difference the probe window budgets for. */
export const MAX_INTRO_DIFF_S = 45;
export const WINDOW_MIN_S = 75;
export const WINDOW_MAX_S = 150;
/** Anything beyond this is a wrong alignment, not an offset. */
export const MAX_PLAUSIBLE_OFFSET_MS = 90_000;

export interface OffsetProbe {
  /** Reference text: the first sung lines, one per line. */
  text: string;
  /** The same lines individually, with their LRC times. */
  lineTexts: string[];
  lineTimesMs: number[];
  /** LRC time of the first of them. */
  firstLineMs: number;
  /** How many seconds of the video the worker should look at. */
  windowS: number;
  lineCount: number;
}

export function isCreditLine(text: string): boolean {
  return CREDIT_RE.test(text.trim());
}

/** What to send the worker for `lines` (time-sorted), or null when nothing is sung. */
export function offsetProbe(lines: LrcLine[]): OffsetProbe | null {
  const sung = lines.filter((l) => l.text.trim() && !isCreditLine(l.text));
  const first = sung[0];
  if (!first) return null;
  const picked = sung.filter((l) => l.timeMs <= first.timeMs + PROBE_SPAN_MS).slice(0, PROBE_MAX_LINES);
  const last = picked[picked.length - 1]!;
  // Cover the last probed line even if the video's intro is MAX_INTRO_DIFF_S
  // longer, plus ~10 s for it to be sung.
  const windowS = Math.min(
    WINDOW_MAX_S,
    Math.max(WINDOW_MIN_S, Math.ceil(last.timeMs / 1000 + MAX_INTRO_DIFF_S + 10)),
  );
  return {
    text: picked.map((l) => l.text.trim()).join('\n'),
    lineTexts: picked.map((l) => l.text.trim()),
    lineTimesMs: picked.map((l) => l.timeMs),
    firstLineMs: first.timeMs,
    windowS,
    lineCount: picked.length,
  };
}

/** One segment of what Whisper heard in the probe window. */
export interface HeardLine {
  text: string;
  startS: number;
  endS?: number;
}

export interface OffsetEstimate {
  offsetMs: number;
  /** How many recognised lines agreed on it (0 = energy-onset fallback). */
  linesUsed: number;
  /** Recognised lines whose answer was too far from the rest to be the same cut. */
  outliers: number;
  /** Spread between the lowest and highest agreeing per-line answer, ms. */
  spreadMs: number;
  note: string | null;
}

/**
 * Dice bigram similarity a heard segment needs to count as a lyric line.
 * Whisper mishears sung words freely ("Take your dreams" for "Hey, cute
 * jeans"), so this is lenient; the monotonic pairing and the median keep
 * stray matches from mattering.
 */
export const MIN_LINE_SIMILARITY = 0.3;
/** Skipping ahead k lines costs this much similarity: prefer the next line. */
const SKIP_PENALTY = 0.02;
/** Per-line answers further apart than this get a warning. */
const DISAGREE_MS = 2500;
/** A per-line answer this far from the median is a misrecognition, not a cut. */
const OUTLIER_MS = 4000;

function lineSimilarity(a: string, b: string): number {
  // Backing-vocal echoes "(jeans)" are not sung by the lead; Whisper writes
  // kana where lyrics have katakana (and vice versa).
  const clean = (s: string) => kataToHira(s.replace(/[(（][^)）]*[)）]/g, ' '));
  return diceSimilarity(clean(a), clean(b));
}

export interface LineMatch {
  heard: number;
  line: number;
  /** 1, or 2 when the segment covers this line and the next one. */
  span: 1 | 2;
  similarity: number;
}

/** How well heard segment `seg` fits lines[i] (alone or with the next line). */
function candidate(seg: HeardLine, probe: OffsetProbe, i: number): { similarity: number; span: 1 | 2 } | null {
  const { lineTexts: lines, lineTimesMs: times } = probe;
  const single = lineSimilarity(seg.text, lines[i]!);
  const joined = i + 1 < lines.length ? lineSimilarity(seg.text, `${lines[i]} ${lines[i + 1]}`) : 0;
  const similarity = Math.max(single, joined);
  if (similarity < MIN_LINE_SIMILARITY) return null;
  let span: 1 | 2 = joined > single ? 2 : 1;
  // Text alone rarely tells one line from two when Whisper misheard both;
  // the segment's length against the LRC's line lengths does.
  const durS = seg.endS !== undefined ? seg.endS - seg.startS : null;
  if (span === 1 && durS !== null && i + 1 < lines.length && joined >= 0.75 * single) {
    const oneS = (times[i + 1]! - times[i]!) / 1000;
    const twoS = i + 2 < times.length ? (times[i + 2]! - times[i]!) / 1000 : oneS * 2;
    if (Math.abs(durS - twoS) < Math.abs(durS - oneS)) span = 2;
  }
  return { similarity, span };
}

/**
 * Pair what was heard with the probed lines: monotonic (a later segment
 * never matches an earlier line, so repeated lines resolve to their next
 * occurrence), any segment or line may go unmatched, and the assignment
 * with the highest total similarity wins — a stray look-alike cannot block
 * the real matches after it, as a greedy pass would let it. A segment may
 * cover one line or two consecutive ones: Whisper likes to merge short
 * lines into one segment, and then the segment's start belongs to the
 * first of the two.
 */
export function matchHeardLines(heard: HeardLine[], probe: OffsetProbe): LineMatch[] {
  const n = probe.lineTexts.length;
  const m = heard.length;
  // best[h][i]: top score having considered heard[0..h) with lines[0..i) used up.
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(-Infinity));
  const from: ({ i: number; match: LineMatch | null } | null)[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(null),
  );
  best[0]![0] = 0;
  for (let h = 0; h < m; h++) {
    for (let i = 0; i <= n; i++) {
      const cur = best[h]![i]!;
      if (cur === -Infinity) continue;
      // Leave this segment unmatched.
      if (cur > best[h + 1]![i]!) {
        best[h + 1]![i] = cur;
        from[h + 1]![i] = { i, match: null };
      }
      for (let j = i; j < n; j++) {
        const c = candidate(heard[h]!, probe, j);
        if (!c) continue;
        const score = cur + c.similarity - SKIP_PENALTY * (j - i);
        const to = Math.min(n, j + c.span);
        if (score > best[h + 1]![to]!) {
          best[h + 1]![to] = score;
          from[h + 1]![to] = { i, match: { heard: h, line: j, span: c.span, similarity: c.similarity } };
        }
      }
    }
  }
  let endI = 0;
  for (let i = 1; i <= n; i++) if (best[m]![i]! > best[m]![endI]!) endI = i;
  const out: LineMatch[] = [];
  for (let h = m, i = endI; h > 0; h--) {
    const step = from[h]![i]!;
    if (step.match) out.push(step.match);
    i = step.i;
  }
  return out.reverse();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Turn what the worker heard into one offset. Every recognised line gives
 * its own answer (LRC time − heard time); the median is taken so a line
 * the video cuts differently, or one mismatch, cannot drag the result.
 * When nothing was recognised (whispered intro, badly misheard language),
 * the vocals' energy onset stands in for the first line.
 */
export function estimateOffset(
  probe: OffsetProbe,
  heard: HeardLine[],
  energyOnsetS: number | null,
): OffsetEstimate | null {
  const matches = matchHeardLines(heard, probe);
  const all = matches.map((m) => probe.lineTimesMs[m.line]! - heard[m.heard]!.startS * 1000);
  if (all.length) {
    // A look-alike line matched far from the others says nothing about the
    // cut; drop it before judging agreement (the median already ignored it).
    const med = median(all);
    const deltas = all.filter((d) => Math.abs(d - med) <= OUTLIER_MS);
    const spreadMs = Math.max(...deltas) - Math.min(...deltas);
    return {
      offsetMs: Math.round(median(deltas)),
      linesUsed: deltas.length,
      outliers: all.length - deltas.length,
      spreadMs: Math.round(spreadMs),
      note:
        spreadMs > DISAGREE_MS
          ? `The ${deltas.length} recognised lines disagree by ${(spreadMs / 1000).toFixed(1)} s — the video may be cut differently; check the sync`
          : null,
    };
  }
  if (energyOnsetS !== null) {
    return {
      offsetMs: offsetMsFor(probe.firstLineMs, energyOnsetS),
      linesUsed: 0,
      outliers: 0,
      spreadMs: 0,
      note: 'None of the lines were recognised in the audio — assumed the first line starts with the first vocal sound',
    };
  }
  return null;
}

/**
 * The offset that makes the LRC's first line coincide with the vocal onset.
 * Display time = video time + offset (see App hotkeys), so a video whose
 * intro is longer than the recording's needs a negative offset.
 */
export function offsetMsFor(firstLineMs: number, onsetS: number): number {
  return Math.round(firstLineMs - onsetS * 1000);
}

export function formatOffset(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)} s`;
}
