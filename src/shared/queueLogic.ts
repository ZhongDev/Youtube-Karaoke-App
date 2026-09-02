// Pure queue-ordering helpers (SPEC.md §7 queue panel). The persisted queue
// is an ordered list whose FIRST item is always the one now playing; finished
// or skipped songs are removed from the head ("consume" model). Keeping the
// index arithmetic here makes it unit-testable without SQLite or React.

export type QueueAddMode = 'end' | 'next';

/** Index at which a newly added item goes. 'next' = right after now-playing. */
export function insertIndexFor(length: number, mode: QueueAddMode): number {
  if (mode === 'end' || length === 0) return length;
  return 1;
}

/**
 * Move `id` so that it ends up at `toIndex` in the resulting list. Index 0 is
 * now-playing and is pinned: an item dropped there lands at 1 instead (use
 * `moveToFront` for the explicit "play this now" gesture). Unknown ids and
 * no-op moves return the input array unchanged.
 */
export function moveItem(ids: number[], id: number, toIndex: number): number[] {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const rest = ids.filter((x) => x !== id);
  const clamped = Math.max(from === 0 ? 0 : 1, Math.min(toIndex, rest.length));
  if (clamped === from) return ids;
  rest.splice(clamped, 0, id);
  return rest;
}

/** "Play this now": `id` becomes the head; the previous head shifts to 1. */
export function moveToFront(ids: number[], id: number): number[] {
  if (!ids.includes(id) || ids[0] === id) return ids;
  return [id, ...ids.filter((x) => x !== id)];
}

/**
 * Drag-and-drop helper. While hovering over the item at `hoverIndex`, the
 * pointer is either in its top or bottom half, which selects the gap before
 * or after it. Gaps are numbered 0..length (gap g = "before item g"). Gap 0
 * is never offered because index 0 is pinned.
 */
export function gapForHover(hoverIndex: number, belowMidpoint: boolean): number {
  return Math.max(1, hoverIndex + (belowMidpoint ? 1 : 0));
}

/**
 * Translate a drop gap (in the list as displayed, dragged item still present)
 * into the item's final index once it has been removed from its old slot.
 */
export function gapToFinalIndex(gap: number, dragIndex: number): number {
  return gap > dragIndex ? gap - 1 : gap;
}
