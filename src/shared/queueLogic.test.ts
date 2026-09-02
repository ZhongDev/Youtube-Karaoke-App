import { describe, expect, it } from 'vitest';
import {
  gapForHover,
  gapToFinalIndex,
  insertIndexFor,
  moveItem,
  moveToFront,
} from './queueLogic';

describe('insertIndexFor', () => {
  it('appends for "end"', () => {
    expect(insertIndexFor(0, 'end')).toBe(0);
    expect(insertIndexFor(3, 'end')).toBe(3);
  });
  it('"next" goes right after now-playing, or first when empty', () => {
    expect(insertIndexFor(0, 'next')).toBe(0);
    expect(insertIndexFor(1, 'next')).toBe(1);
    expect(insertIndexFor(5, 'next')).toBe(1);
  });
});

describe('moveItem', () => {
  const ids = [10, 20, 30, 40];
  it('moves down', () => {
    expect(moveItem(ids, 20, 3)).toEqual([10, 30, 40, 20]);
  });
  it('moves up', () => {
    expect(moveItem(ids, 40, 1)).toEqual([10, 40, 20, 30]);
  });
  it('clamps to the end', () => {
    expect(moveItem(ids, 20, 99)).toEqual([10, 30, 40, 20]);
  });
  it('never displaces the pinned head', () => {
    expect(moveItem(ids, 30, 0)).toEqual([10, 30, 20, 40]);
  });
  it('is a no-op for unknown ids and same-position moves', () => {
    expect(moveItem(ids, 99, 1)).toBe(ids);
    expect(moveItem(ids, 20, 1)).toBe(ids);
    expect(moveItem(ids, 10, 0)).toBe(ids);
  });
  it('lets the head be moved down explicitly', () => {
    expect(moveItem(ids, 10, 2)).toEqual([20, 30, 10, 40]);
  });
});

describe('moveToFront', () => {
  it('puts the item first and shifts the old head to second', () => {
    expect(moveToFront([1, 2, 3], 3)).toEqual([3, 1, 2]);
  });
  it('is a no-op for the head and unknown ids', () => {
    const ids = [1, 2, 3];
    expect(moveToFront(ids, 1)).toBe(ids);
    expect(moveToFront(ids, 9)).toBe(ids);
  });
});

describe('drag gap arithmetic', () => {
  it('picks the gap before/after the hovered item, never gap 0', () => {
    expect(gapForHover(0, false)).toBe(1);
    expect(gapForHover(0, true)).toBe(1);
    expect(gapForHover(2, false)).toBe(2);
    expect(gapForHover(2, true)).toBe(3);
  });
  it('accounts for the dragged item leaving its old slot', () => {
    // Dragging item at 1 to the gap after item 3 (gap 4) → final index 3.
    expect(gapToFinalIndex(4, 1)).toBe(3);
    // Dragging item at 3 up to gap 1 → final index 1.
    expect(gapToFinalIndex(1, 3)).toBe(1);
    // Gaps adjacent to the item itself are no-ops.
    expect(gapToFinalIndex(2, 2)).toBe(2);
    expect(gapToFinalIndex(3, 2)).toBe(2);
  });
  it('round-trips through moveItem', () => {
    const ids = [1, 2, 3, 4, 5];
    const dragIndex = 1; // id 2
    const gap = gapForHover(3, true); // after id 4 → gap 4
    expect(moveItem(ids, 2, gapToFinalIndex(gap, dragIndex))).toEqual([1, 3, 4, 2, 5]);
  });
});
