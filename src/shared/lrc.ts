// LRC parser. Handles the SPEC.md §8 quirks:
//   [01:10.00][02:30.00]same line    multiple timestamps per line
//   [ti:] [ar:] [offset:+500]        metadata tags; offset is APPLIED to times
//   <mm:ss.xx>                       enhanced per-word tags
//   CRLF, BOM, blank timed lines (used as spacing between verses).
//
// Sign convention for [offset:] (de-facto standard): positive shifts lyrics
// earlier, i.e. effective time = tag time − offset. Times are clamped at 0.

export interface LrcWord {
  timeMs: number;
  /** Raw text segment including its trailing spacing, for exact re-joining. */
  text: string;
}

export interface LrcLine {
  timeMs: number;
  text: string;
  /** Present only for enhanced (word-synced) lines. */
  words?: LrcWord[];
}

export interface ParsedLrc {
  kind: 'synced_line' | 'synced_word';
  /** Sorted by timeMs, [offset:] already applied. */
  lines: LrcLine[];
  meta: Record<string, string>;
  offsetMs: number;
}

// Sticky flag: exec() only matches exactly at lastIndex, which gives us the
// contiguous run of [mm:ss.xx] tags at the start of a line for free.
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_TAG = /^\s*\[([a-zA-Z][a-zA-Z0-9#_-]*):([^\]]*)\]\s*$/;

function tagMs(min: string, sec: string, frac: string | undefined): number {
  // Fraction digits are hundredths by convention but files vary: '5' → 500ms,
  // '50' → 500ms, '500' → 500ms.
  const fracMs = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return Number(min) * 60_000 + Number(sec) * 1000 + fracMs;
}

/** Returns null when the text contains no timestamps at all (plain lyrics). */
export function parseLrc(raw: string): ParsedLrc | null {
  const meta: Record<string, string> = {};
  const lines: LrcLine[] = [];
  let sawWordTags = false;

  for (const rawLine of raw.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();

    const metaMatch = META_TAG.exec(line);
    if (metaMatch) {
      meta[metaMatch[1]!.toLowerCase()] = metaMatch[2]!.trim();
      continue;
    }

    const times: number[] = [];
    TIME_TAG.lastIndex = 0;
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line))) {
      times.push(tagMs(m[1]!, m[2]!, m[3]));
      cursor = TIME_TAG.lastIndex;
    }
    if (!times.length) continue; // untimed stray line — ignore

    const rest = line.slice(cursor);
    let words: LrcWord[] | undefined;
    let text: string;

    WORD_TAG.lastIndex = 0;
    if (WORD_TAG.test(rest)) {
      words = [];
      WORD_TAG.lastIndex = 0;
      let prefix = '';
      let prev: { timeMs: number; start: number } | null = null;
      let wm: RegExpExecArray | null;
      while ((wm = WORD_TAG.exec(rest))) {
        if (prev) {
          const seg = rest.slice(prev.start, wm.index);
          if (seg.trim()) words.push({ timeMs: prev.timeMs, text: seg });
        } else {
          prefix = rest.slice(0, wm.index);
        }
        prev = { timeMs: tagMs(wm[1]!, wm[2]!, wm[3]), start: WORD_TAG.lastIndex };
      }
      if (prev) {
        const seg = rest.slice(prev.start);
        if (seg.trim()) words.push({ timeMs: prev.timeMs, text: seg });
      }
      text = (prefix + words.map((w) => w.text).join('')).trim();
      if (words.length) sawWordTags = true;
      else words = undefined;
    } else {
      text = rest.trim();
    }

    for (const t of times) {
      lines.push({
        timeMs: t,
        text,
        ...(words ? { words: words.map((w) => ({ ...w })) } : {}),
      });
    }
  }

  if (!lines.length) return null;

  const offsetMs = Math.trunc(Number(meta['offset'] ?? 0)) || 0;
  if (offsetMs !== 0) {
    for (const l of lines) {
      l.timeMs = Math.max(0, l.timeMs - offsetMs);
      l.words?.forEach((w) => {
        w.timeMs = Math.max(0, w.timeMs - offsetMs);
      });
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);

  return { kind: sawWordTags ? 'synced_word' : 'synced_line', lines, meta, offsetMs };
}

/** Index of the active line at tMs (last line with timeMs <= tMs), or -1. */
export function lineIndexAt(lines: LrcLine[], tMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.timeMs <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
