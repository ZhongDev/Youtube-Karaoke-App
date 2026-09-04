import { describe, expect, it } from 'vitest';
import type { LrcLine } from './lrc';
import { parseLrc } from './lrc';
import {
  FADE_MAX_MS,
  FADE_MIN_MS,
  HOLD_MAX_MS,
  LEAD_MS,
  estimateSingMs,
  laneStateAt,
  scheduleTwoTrack,
  wipeEndOf,
  wipeProgress,
} from './twoTrack';

const L = (timeMs: number, text: string, words?: LrcLine['words']): LrcLine => ({
  timeMs,
  text,
  ...(words ? { words } : {}),
});

function entryFor(sched: ReturnType<typeof scheduleTwoTrack>, index: number) {
  return sched.lanes.flat().find((e) => e.index === index)!;
}

describe('estimateSingMs', () => {
  it('scales with text, treats CJK as syllables, clamps', () => {
    expect(estimateSingMs('')).toBe(600);
    expect(estimateSingMs('Never gonna give you up')).toBe(19 * 130);
    expect(estimateSingMs('夜に駆ける')).toBe(5 * 280);
    expect(estimateSingMs('x'.repeat(500))).toBe(12_000);
  });
});

describe('wipeEndOf', () => {
  it('uses the estimate but never runs past the next timestamp', () => {
    expect(wipeEndOf(L(1000, 'hello world'), Infinity)).toBe(1000 + 10 * 130);
    expect(wipeEndOf(L(1000, 'hello world'), 1500)).toBe(1500);
  });

  it('ends word-synced lines after the last word', () => {
    const line = L(1000, 'ab cd', [
      { timeMs: 1000, text: 'ab ' },
      { timeMs: 2000, text: 'cd' },
    ]);
    expect(wipeEndOf(line, Infinity)).toBe(2000 + 600);
    expect(wipeEndOf(line, 2300)).toBe(2300);
  });
});

describe('scheduleTwoTrack', () => {
  const lines = [L(10_000, 'one'), L(14_000, 'two'), L(18_000, 'three'), L(22_000, 'four')];
  const sched = scheduleTwoTrack(lines);

  it('alternates lanes in order', () => {
    expect(sched.lanes[0].map((e) => e.index)).toEqual([0, 2]);
    expect(sched.lanes[1].map((e) => e.index)).toEqual([1, 3]);
  });

  it('shows each line LEAD ms early when the lane is free', () => {
    expect(entryFor(sched, 0).showMs).toBe(10_000 - LEAD_MS);
    expect(entryFor(sched, 1).showMs).toBe(14_000 - LEAD_MS);
    // Lane 0 is free again well before "three" wants it (one wipes for ~400ms).
    expect(entryFor(sched, 2).showMs).toBe(18_000 - LEAD_MS);
  });

  it('never fades out before the wipe completes, and frees the lane in time', () => {
    for (const e of sched.lanes.flat()) {
      expect(e.departMs).toBeGreaterThanOrEqual(e.wipeEndMs);
      expect(e.goneMs).toBe(e.departMs + e.fadeOutMs);
    }
    const one = entryFor(sched, 0);
    const three = entryFor(sched, 2);
    expect(one.goneMs).toBeLessThanOrEqual(three.showMs);
  });

  it('clamps the first line at t=0 and fades the last lines slowly', () => {
    const s = scheduleTwoTrack([L(500, 'early')]);
    const e = s.lanes[0][0]!;
    expect(e.showMs).toBe(0);
    expect(e.fadeInMs).toBe(Math.max(FADE_MIN_MS, 250));
    expect(e.departMs).toBe(e.wipeEndMs + HOLD_MAX_MS);
    expect(e.fadeOutMs).toBe(FADE_MAX_MS);
  });

  it('places a line late when both lanes are busy, with fast fades', () => {
    // Fast passage: 1s per line, long text so each wipe fills its slot.
    const fast = [0, 1, 2, 3, 4].map((i) => L(10_000 + i * 1000, 'a fairly long line of lyrics'));
    const s = scheduleTwoTrack(fast);
    const l0 = entryFor(s, 0);
    const l2 = entryFor(s, 2);
    // "0" wipes until 11s (capped by "1"), lane needed by "2" at 9s → too
    // late: "2" appears only once "0" has gone, with the minimum fade.
    expect(l0.wipeEndMs).toBe(11_000);
    expect(l0.fadeOutMs).toBe(FADE_MIN_MS);
    expect(l0.departMs).toBe(11_000);
    expect(l2.showMs).toBe(l0.goneMs);
    expect(l2.showMs).toBeGreaterThan(12_000 - LEAD_MS);
    expect(l2.showMs).toBeLessThan(12_000);
    expect(l2.fadeInMs).toBeLessThan(1000);
  });

  it('holds a finished line briefly then fades slowly around a break', () => {
    const s = scheduleTwoTrack([L(10_000, 'short'), L(12_000, 'next'), L(40_000, 'after break')]);
    const first = entryFor(s, 0);
    const third = entryFor(s, 2); // same lane as first
    expect(third.lane).toBe(first.lane);
    expect(first.fadeOutMs).toBe(FADE_MAX_MS);
    expect(first.departMs).toBe(first.wipeEndMs + HOLD_MAX_MS);
    expect(third.showMs).toBe(40_000 - LEAD_MS);
    expect(third.fadeInMs).toBe(1500);
  });

  it('skips blank spacer lines but lets them end the previous line', () => {
    const parsed = parseLrc('[00:10.00]sing this rather long line\n[00:11.00]\n[00:20.00]later')!;
    const s = scheduleTwoTrack(parsed.lines);
    expect(s.lanes.flat().map((e) => e.index).sort()).toEqual([0, 2]);
    expect(entryFor(s, 0).wipeEndMs).toBe(11_000);
  });

  it('is empty for no lines', () => {
    expect(scheduleTwoTrack([]).lanes).toEqual([[], []]);
  });
});

describe('wipeProgress', () => {
  it('is linear for line-synced lines', () => {
    const line = L(1000, 'abcd');
    const e = scheduleTwoTrack([line]).lanes[0][0]!;
    expect(wipeProgress(line, e, 900)).toBe(0);
    expect(wipeProgress(line, e, (1000 + e.wipeEndMs) / 2)).toBeCloseTo(0.5);
    expect(wipeProgress(line, e, e.wipeEndMs + 1)).toBe(1);
  });

  it('follows word tags, weighted by characters', () => {
    const line = L(1000, 'aaaa bb', [
      { timeMs: 1000, text: 'aaaa ' }, // 5 chars
      { timeMs: 2000, text: 'bb' }, // 2 chars
    ]);
    const e = scheduleTwoTrack([line]).lanes[0][0]!;
    expect(wipeProgress(line, e, 1500)).toBeCloseTo((0.5 * 5) / 7);
    expect(wipeProgress(line, e, 2000)).toBeCloseTo(5 / 7);
    expect(wipeProgress(line, e, e.wipeEndMs)).toBe(1);
  });
});

describe('laneStateAt', () => {
  const lines = [L(10_000, 'one'), L(14_000, 'two'), L(18_000, 'three')];
  const sched = scheduleTwoTrack(lines);

  it('returns null before anything is shown and after everything is gone', () => {
    expect(laneStateAt(sched, lines, 0, 0)).toBeNull();
    expect(laneStateAt(sched, lines, 1, 0)).toBeNull();
    expect(laneStateAt(sched, lines, 0, 100_000)).toBeNull();
  });

  it('ramps opacity through fade-in, full, fade-out', () => {
    const e = entryFor(sched, 0);
    expect(laneStateAt(sched, lines, 0, e.showMs)!.opacity).toBe(0);
    expect(laneStateAt(sched, lines, 0, e.showMs + e.fadeInMs / 2)!.opacity).toBeCloseTo(0.5);
    expect(laneStateAt(sched, lines, 0, e.startMs)!.opacity).toBe(1);
    expect(laneStateAt(sched, lines, 0, e.departMs + e.fadeOutMs / 2)!.opacity).toBeCloseTo(0.5);
    expect(laneStateAt(sched, lines, 0, e.goneMs)).toBeNull();
  });

  it('reports the wipe progress of the shown line', () => {
    const e = entryFor(sched, 1);
    const s = laneStateAt(sched, lines, 1, e.startMs - 1)!;
    expect(s.entry.index).toBe(1);
    expect(s.progress).toBe(0);
    expect(laneStateAt(sched, lines, 1, e.wipeEndMs)!.progress).toBe(1);
  });

  it('picks the right entry when a lane has several', () => {
    const e2 = entryFor(sched, 2);
    expect(laneStateAt(sched, lines, 0, e2.startMs)!.entry.index).toBe(2);
  });
});
