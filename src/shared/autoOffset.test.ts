import { describe, expect, it } from 'vitest';
import {
  estimateOffset,
  formatOffset,
  matchHeardLines,
  isCreditLine,
  offsetMsFor,
  offsetProbe,
  PROBE_MAX_LINES,
  WINDOW_MAX_S,
  WINDOW_MIN_S,
} from './autoOffset';
import type { LrcLine } from './lrc';

const L = (timeMs: number, text: string): LrcLine => ({ timeMs, text });

describe('isCreditLine', () => {
  it('spots provider credit headers in several languages', () => {
    expect(isCreditLine('作詞：Ayase')).toBe(true);
    expect(isCreditLine('作曲 : Ayase')).toBe(true);
    expect(isCreditLine('Lyrics: Rick Astley')).toBe(true);
    expect(isCreditLine('Music/Lyrics: X')).toBe(true);
    expect(isCreditLine('Music is my life')).toBe(false); // needs a colon / slash after the role
    expect(isCreditLine('Never gonna give you up')).toBe(false);
    expect(isCreditLine('歌: 誰か')).toBe(false); // 歌 alone is a lyric word too
  });
});

describe('offsetProbe', () => {
  it('skips blanks and credits, keeps lines within the span, caps the count', () => {
    const lines = [
      L(0, '作詞：Ayase'),
      L(500, ''),
      L(12_000, 'first'),
      L(20_000, 'second'),
      L(41_000, 'third'),
      L(43_000, 'too late'),
    ];
    const p = offsetProbe(lines)!;
    expect(p.firstLineMs).toBe(12_000);
    expect(p.lineTimesMs).toEqual([12_000, 20_000, 41_000]);
    expect(p.lineTexts).toEqual(['first', 'second', 'third']);
    expect(p.text).toBe('first\nsecond\nthird');
    expect(p.lineCount).toBe(3);
    // last probed line at 41 s + 45 s slack + 10 s singing = 96 s
    expect(p.windowS).toBe(96);

    const many = Array.from({ length: 20 }, (_, i) => L(1000 + i * 1000, `l${i}`));
    expect(offsetProbe(many)!.lineCount).toBe(PROBE_MAX_LINES);
  });

  it('clamps the window and returns null with nothing to sing', () => {
    expect(offsetProbe([L(1000, 'a')])!.windowS).toBe(WINDOW_MIN_S);
    expect(offsetProbe([L(200_000, 'late start')])!.windowS).toBe(WINDOW_MAX_S);
    expect(offsetProbe([L(0, '作曲：X'), L(1000, '  ')])).toBeNull();
    expect(offsetProbe([])).toBeNull();
  });
});

describe('estimateOffset', () => {
  // Real data: Tate McRae — Sports car. LRCLIB lyrics timed to the 167 s
  // single; the 188 s MV adds a longer intro. Whisper on the MV's first 45 s:
  const heard = [
    { text: 'Take your dreams, take a run off me', startS: 24.24, endS: 28.12 },
    { text: 'Oh, girl, the key', startS: 29.36, endS: 30.36 },
    { text: "I can't take no more, I'm going weak in my knees", startS: 30.74, endS: 34.84 },
    { text: 'Let you put those keys', startS: 35.46, endS: 37.1 },
    { text: 'We can share one seat', startS: 37.75, endS: 39.48 },
    { text: 'We can share one seat', startS: 40.48, endS: 41.84 },
    { text: 'And I am dead', startS: 43.34, endS: 44.4 },
  ];
  const probe = offsetProbe([
    L(560, 'Illegal'),
    L(5360, 'Illegal'),
    L(10_510, 'Hey, cute jeans (jeans)'),
    L(12_890, 'Take mine off me (me)'),
    L(14_830, 'Oh, golly gee (gee)'),
    L(17_030, "I can't take no more, I'm goin' weak in my knees"),
    L(21_280, "Where'd you put those keys?"),
    L(23_620, 'We can share one seat (seat)'),
    L(25_940, 'We can share one seat'),
  ])!;

  it('matches monotonically, merging two short lines into one heard segment', () => {
    const m = matchHeardLines(heard, probe);
    expect(m.map((x) => [x.heard, x.line, x.span])).toEqual([
      [0, 2, 2], // "Hey, cute jeans / Take mine off me" heard as one 3.9 s segment
      [2, 5, 1],
      [3, 6, 1],
      [4, 7, 1],
      [5, 8, 1], // the repeated line resolves to its next occurrence
    ]);
  });

  it('lands within half a second of the hand-tuned offset (−14.3 s)', () => {
    const e = estimateOffset(probe, heard, 24.15)!;
    expect(e.linesUsed).toBe(5);
    expect(e.offsetMs).toBeGreaterThan(-14_500);
    expect(e.offsetMs).toBeLessThan(-13_500);
    expect(e.spreadMs).toBeLessThan(1000);
    expect(e.note).toBeNull();
  });

  it('warns when the recognised lines disagree, but not about a lone outlier', () => {
    const shifted = heard.map((h, i) => (i === 3 ? { ...h, startS: h.startS + 3 } : h));
    const e = estimateOffset(probe, shifted, null)!;
    expect(e.linesUsed).toBe(5);
    expect(e.outliers).toBe(0);
    expect(e.note).toMatch(/disagree by 3\.\d s/);

    // A look-alike matched 25 s away is a misrecognition: ignored, no warning.
    const stray = [...heard, { text: 'We can share one seat', startS: 70, endS: 71 }];
    const wide = [
      ...probe.lineTexts.map((t, i) => L(probe.lineTimesMs[i]!, t)),
      L(29_000, 'We can share one seat'),
    ];
    const s = estimateOffset(offsetProbe(wide)!, stray, null)!;
    expect(s.outliers).toBe(1);
    expect(s.linesUsed).toBe(5);
    expect(s.note).toBeNull();
    expect(s.offsetMs).toBeGreaterThan(-14_500);
    expect(s.offsetMs).toBeLessThan(-13_500);
  });

  it('falls back to the energy onset, then to null', () => {
    const e = estimateOffset(probe, [{ text: 'la la la', startS: 30 }], 24.15)!;
    expect(e.linesUsed).toBe(0);
    expect(e.offsetMs).toBe(560 - 24_150);
    expect(e.note).toMatch(/first vocal sound/);
    expect(estimateOffset(probe, [], null)).toBeNull();
  });

  it('never matches an earlier line than the previous segment did', () => {
    const backwards = [
      { text: 'We can share one seat', startS: 37.75, endS: 39.48 },
      { text: 'Hey, cute jeans', startS: 40.0, endS: 41.0 },
    ];
    const m = matchHeardLines(backwards, probe);
    // Only one of the two can be kept (the exact match wins); never [7, 2].
    expect(m.map((x) => x.line)).toEqual([2]);
  });
});

describe('offsetMsFor / formatOffset', () => {
  it('is negative when the video intro is longer than the recording', () => {
    expect(offsetMsFor(12_500, 32.5)).toBe(-20_000);
    expect(offsetMsFor(12_500, 12.5)).toBe(0);
    expect(offsetMsFor(12_500, 10.25)).toBe(2250);
  });

  it('formats with a sign and one decimal', () => {
    expect(formatOffset(-20_000)).toBe('−20.0 s');
    expect(formatOffset(2250)).toBe('+2.3 s');
    expect(formatOffset(0)).toBe('0.0 s');
  });
});
