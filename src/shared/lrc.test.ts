import { describe, expect, it } from 'vitest';
import { lineIndexAt, parseLrc } from './lrc';

describe('parseLrc', () => {
  it('parses basic lines sorted by time', () => {
    const p = parseLrc('[00:12.00]hello\n[00:05.50]world');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('synced_line');
    expect(p!.lines.map((l) => [l.timeMs, l.text])).toEqual([
      [5500, 'world'],
      [12000, 'hello'],
    ]);
  });

  it('expands multiple timestamps on one line', () => {
    const p = parseLrc('[01:10.00][02:30.00]same line\n[00:01.00]first')!;
    expect(p.lines.map((l) => [l.timeMs, l.text])).toEqual([
      [1000, 'first'],
      [70000, 'same line'],
      [150000, 'same line'],
    ]);
  });

  it('captures metadata tags and applies positive [offset:] (earlier)', () => {
    const p = parseLrc('[ti:Song]\n[ar:Artist]\n[offset:+500]\n[00:10.00]line')!;
    expect(p.meta['ti']).toBe('Song');
    expect(p.meta['ar']).toBe('Artist');
    expect(p.offsetMs).toBe(500);
    expect(p.lines[0]!.timeMs).toBe(9500);
  });

  it('applies negative [offset:] (later) and clamps at zero', () => {
    const p = parseLrc('[offset:-250]\n[00:10.00]line')!;
    expect(p.lines[0]!.timeMs).toBe(10250);
    const clamped = parseLrc('[offset:5000]\n[00:02.00]early')!;
    expect(clamped.lines[0]!.timeMs).toBe(0);
  });

  it('parses enhanced word tags', () => {
    const p = parseLrc('[00:10.00]<00:10.00>Never <00:10.40>gonna <00:10.80>give')!;
    expect(p.kind).toBe('synced_word');
    const line = p.lines[0]!;
    expect(line.text).toBe('Never gonna give');
    expect(line.words!.map((w) => [w.timeMs, w.text.trim()])).toEqual([
      [10000, 'Never'],
      [10400, 'gonna'],
      [10800, 'give'],
    ]);
  });

  it('handles BOM and CRLF', () => {
    const p = parseLrc('﻿[00:01.00]a\r\n[00:02.00]b\r\n')!;
    expect(p.lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('keeps empty timed lines (verse spacing)', () => {
    const p = parseLrc('[00:01.00]sing\n[00:05.00]\n[00:09.00]more')!;
    expect(p.lines[1]).toMatchObject({ timeMs: 5000, text: '' });
  });

  it('supports [mm:ss:xx] colon fraction and short/long fractions', () => {
    const p = parseLrc('[00:01:50]colon\n[00:02.4]short\n[00:03.456]long')!;
    expect(p.lines.map((l) => l.timeMs)).toEqual([1500, 2400, 3456]);
  });

  it('ignores untimed stray lines but keeps timed ones', () => {
    const p = parseLrc('Some header text\n[00:01.00]real')!;
    expect(p.lines).toHaveLength(1);
  });

  it('returns null for plain text without any timestamps', () => {
    expect(parseLrc('just some lyrics\nwith lines')).toBeNull();
    expect(parseLrc('')).toBeNull();
  });
});

describe('lineIndexAt', () => {
  const lines = [
    { timeMs: 1000, text: 'a' },
    { timeMs: 5000, text: 'b' },
    { timeMs: 9000, text: 'c' },
  ];
  it('finds the active line', () => {
    expect(lineIndexAt(lines, 0)).toBe(-1);
    expect(lineIndexAt(lines, 1000)).toBe(0);
    expect(lineIndexAt(lines, 4999)).toBe(0);
    expect(lineIndexAt(lines, 5000)).toBe(1);
    expect(lineIndexAt(lines, 99999)).toBe(2);
  });
});
