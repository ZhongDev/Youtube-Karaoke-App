import { describe, expect, it } from 'vitest';
import { SyncClock } from './syncClock';

describe('SyncClock', () => {
  it('returns 0 before any poll', () => {
    expect(new SyncClock().timeS(12345)).toBe(0);
  });

  it('interpolates between polls while playing', () => {
    const c = new SyncClock();
    c.poll(10, 1000, 1, true);
    expect(c.timeS(1000)).toBe(10);
    expect(c.timeS(1100)).toBeCloseTo(10.1);
    expect(c.timeS(1250)).toBeCloseTo(10.25);
  });

  it('scales interpolation by playback rate', () => {
    const c = new SyncClock();
    c.poll(10, 0, 2, true);
    expect(c.timeS(500)).toBeCloseTo(11);
  });

  it('freezes while paused or buffering', () => {
    const c = new SyncClock();
    c.poll(10, 0, 1, false);
    expect(c.timeS(5000)).toBe(10);
  });

  it('adopts each polled value (gentle correction)', () => {
    const c = new SyncClock();
    c.poll(10, 0, 1, true);
    // Player is slightly behind our estimate — next poll wins.
    expect(c.poll(10.2, 250, 1, true)).toBe(false);
    expect(c.timeS(250)).toBeCloseTo(10.2);
  });

  it('flags a seek when the poll jumps beyond the threshold', () => {
    const c = new SyncClock();
    c.poll(10, 0, 1, true);
    expect(c.poll(42, 250, 1, true)).toBe(true);
    expect(c.timeS(250)).toBe(42);
    // Backwards seek too.
    expect(c.poll(5, 500, 1, true)).toBe(true);
  });

  it('does not flag the very first poll as a seek', () => {
    const c = new SyncClock();
    expect(c.poll(120, 0, 1, true)).toBe(false);
  });

  it('resumes interpolation after pause → play', () => {
    const c = new SyncClock();
    c.poll(10, 0, 1, false);
    expect(c.timeS(2000)).toBe(10);
    c.poll(10, 2000, 1, true);
    expect(c.timeS(2500)).toBeCloseTo(10.5);
  });

  it('reset clears state', () => {
    const c = new SyncClock();
    c.poll(50, 0, 1, true);
    c.reset();
    expect(c.timeS(100)).toBe(0);
  });
});
