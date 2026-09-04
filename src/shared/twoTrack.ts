// Two-track ("Joysound style") lyrics scheduler — the timing brain behind
// the default overlay display.
//
// Two fixed lanes sit in the bottom 40% of the stage. Text never resizes or
// moves: a line fades in, is highlighted with a left→right wipe while it is
// sung, and fades out fully highlighted. Consecutive lines alternate lanes.
//
// Placement rule (per the product spec): a line should be on screen LEAD ms
// before its timestamp when a lane is free; when both lanes are busy it
// appears as soon as its lane's previous line has finished and faded out.
// Fade durations stretch with the slack available — 100 ms in fast passages,
// up to 3 s around breaks — so fades never eat into singing time.
//
// Everything here is pure and unit-tested; the React component only reads
// `laneStateAt` every animation frame.

import type { LrcLine } from './lrc';

export const LEAD_MS = 3000; // how early a line should appear
export const HOLD_MAX_MS = 2000; // max time a finished line lingers when its lane is idle
export const FADE_MIN_MS = 100;
export const FADE_MAX_MS = 3000;

/** Estimated singing time of `text` when no finer timing exists. */
export function estimateSingMs(text: string): number {
  let ms = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    // A CJK character is roughly a syllable; a Latin letter a fraction of one.
    ms += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)
      ? 280
      : 130;
  }
  return Math.min(12_000, Math.max(600, ms));
}

export interface LaneEntry {
  /** Index into the parsed lines array. */
  index: number;
  lane: 0 | 1;
  /** Fade-in starts here … */
  showMs: number;
  fadeInMs: number;
  /** … the line's own timestamp: wipe starts. */
  startMs: number;
  /** Wipe complete (line fully highlighted). */
  wipeEndMs: number;
  /** Fade-out starts here (≥ wipeEndMs) … */
  departMs: number;
  fadeOutMs: number;
  /** Time by which the text is gone and the lane is free. */
  goneMs: number;
}

export interface TwoTrackSchedule {
  lanes: [LaneEntry[], LaneEntry[]];
}

interface Draft {
  index: number;
  lane: 0 | 1;
  startMs: number;
  wipeEndMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * When `line` is fully highlighted. Word-synced lines end when the last word
 * ends; line-synced ones after an estimate — never past the next timestamp.
 */
export function wipeEndOf(line: LrcLine, nextMarkMs: number): number {
  const cap = Number.isFinite(nextMarkMs) ? nextMarkMs : Infinity;
  if (line.words?.length) {
    const last = line.words[line.words.length - 1]!;
    return Math.max(line.timeMs, Math.min(cap, last.timeMs + estimateSingMs(last.text)));
  }
  const est = line.timeMs + estimateSingMs(line.text);
  // A gap shorter than the estimate means the next line takes over — the
  // wipe must be done by then. Never shorter than 300 ms though.
  return Math.max(line.timeMs + Math.min(300, cap - line.timeMs), Math.min(est, cap));
}

/**
 * Build the lane schedule for a parsed (time-sorted) LRC.
 * Blank timed lines are not displayed but do act as end markers for the
 * line before them (LRC files use them to mark rests).
 */
export function scheduleTwoTrack(lines: LrcLine[]): TwoTrackSchedule {
  const lanes: [LaneEntry[], LaneEntry[]] = [[], []];
  const drafts: Draft[] = [];
  const lastInLane: [Draft | null, Draft | null] = [null, null];

  // Text lines in order, each with the next distinct timestamp after it.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.text.trim()) continue;
    let nextMark = Infinity;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.timeMs > line.timeMs) {
        nextMark = lines[k]!.timeMs;
        break;
      }
    }
    drafts.push({ index: i, lane: 0, startMs: line.timeMs, wipeEndMs: wipeEndOf(line, nextMark) });
  }

  const finish = (
    lane: 0 | 1,
    prev: Draft,
    next: Draft | null,
  ): { showMs: number; fadeInMs: number } => {
    // Close out `prev` given the next line that wants this lane (or none).
    const wantMs = next ? next.startMs - LEAD_MS : Infinity;
    const fadeOutMs = next ? clamp((wantMs - prev.wipeEndMs) / 2, FADE_MIN_MS, FADE_MAX_MS) : FADE_MAX_MS;
    const departMs = Math.max(
      prev.wipeEndMs,
      Math.min(wantMs - fadeOutMs, prev.wipeEndMs + HOLD_MAX_MS),
    );
    const goneMs = departMs + fadeOutMs;
    const entry = lanes[lane].find((e) => e.index === prev.index)!;
    entry.departMs = departMs;
    entry.fadeOutMs = fadeOutMs;
    entry.goneMs = goneMs;
    const showMs = Math.max(goneMs, wantMs, 0);
    return { showMs, fadeInMs: clamp((next ? next.startMs - showMs : 0) / 2, FADE_MIN_MS, FADE_MAX_MS) };
  };

  for (const d of drafts) {
    // The lane that frees up first (its last line finishes highlighting
    // earliest); an empty lane wins outright, lane 0 on ties.
    const free = (l: 0 | 1) => lastInLane[l]?.wipeEndMs ?? -Infinity;
    const lane: 0 | 1 = free(1) < free(0) ? 1 : 0;
    d.lane = lane;

    const prev = lastInLane[lane];
    let showMs: number;
    let fadeInMs: number;
    if (prev) {
      ({ showMs, fadeInMs } = finish(lane, prev, d));
    } else {
      showMs = Math.max(0, d.startMs - LEAD_MS);
      fadeInMs = clamp((d.startMs - showMs) / 2, FADE_MIN_MS, FADE_MAX_MS);
    }
    lanes[lane].push({
      index: d.index,
      lane,
      showMs,
      fadeInMs,
      startMs: d.startMs,
      wipeEndMs: d.wipeEndMs,
      departMs: Infinity,
      fadeOutMs: FADE_MAX_MS,
      goneMs: Infinity,
    });
    lastInLane[lane] = d;
  }

  // Last line of each lane: nobody is waiting, linger then fade slowly.
  for (const lane of [0, 1] as const) {
    const last = lastInLane[lane];
    if (last) finish(lane, last, null);
  }
  return { lanes };
}

export interface LaneState {
  entry: LaneEntry;
  /** 0..1 */
  opacity: number;
  /** Wipe progress 0..1 (fraction of the line highlighted). */
  progress: number;
}

/** Highlight fraction of `line` at `tMs`, following word tags when present. */
export function wipeProgress(line: LrcLine, entry: LaneEntry, tMs: number): number {
  if (tMs <= entry.startMs) return 0;
  if (tMs >= entry.wipeEndMs) return 1;
  const words = line.words;
  if (!words?.length) {
    return (tMs - entry.startMs) / (entry.wipeEndMs - entry.startMs);
  }
  // Character-weighted: text before the first word tag counts with word 0.
  const total = words.reduce((n, w) => n + w.text.length, 0);
  if (total === 0) return (tMs - entry.startMs) / (entry.wipeEndMs - entry.startMs);
  let done = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const wStart = k === 0 ? entry.startMs : w.timeMs;
    const wEnd = k + 1 < words.length ? words[k + 1]!.timeMs : entry.wipeEndMs;
    if (tMs >= wEnd) {
      done += w.text.length;
      continue;
    }
    const frac = wEnd > wStart ? clamp((tMs - wStart) / (wEnd - wStart), 0, 1) : 1;
    return clamp((done + frac * w.text.length) / total, 0, 1);
  }
  return 1;
}

/** What lane `lane` shows at `tMs`, or null when it is empty. */
export function laneStateAt(
  schedule: TwoTrackSchedule,
  lines: LrcLine[],
  lane: 0 | 1,
  tMs: number,
): LaneState | null {
  const entries = schedule.lanes[lane];
  // Entries are ordered and non-overlapping: binary-search the last one
  // whose showMs <= tMs, then check it hasn't gone yet.
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.showMs <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const entry = entries[found]!;
  if (tMs >= entry.goneMs) return null;
  const line = lines[entry.index];
  if (!line) return null;

  let opacity = 1;
  if (tMs < entry.showMs + entry.fadeInMs) {
    opacity = (tMs - entry.showMs) / entry.fadeInMs;
  } else if (tMs >= entry.departMs) {
    opacity = 1 - (tMs - entry.departMs) / entry.fadeOutMs;
  }
  return { entry, opacity: clamp(opacity, 0, 1), progress: wipeProgress(line, entry, tMs) };
}
