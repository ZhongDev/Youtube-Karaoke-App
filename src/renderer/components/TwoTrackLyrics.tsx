import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { RubyMode } from '../../shared/ipc';
import type { ParsedLrc } from '../../shared/lrc';
import type { SyncClock } from '../../shared/syncClock';
import { laneStateAt, scheduleTwoTrack, wipeProgress } from '../../shared/twoTrack';
import { annotate, type RubySegment } from '../ruby';

// Joysound-style two-lane display (see shared/twoTrack.ts for the timing
// model). Per frame we read the clock, ask the schedule what each lane shows,
// and poke opacity / wipe clip straight into the DOM — React only re-renders
// when a lane switches to a different line.
//
// The wipe is two clip-paths, not one: the highlight layer is revealed from
// the left up to the sung position, and the base layer underneath is hidden
// from the left up to where the wipe was WIPE_OVERLAP_MS ago. The highlight
// gets its own compositor layer (its clip changes every frame) and can land a
// fraction of a pixel off the base, which let the base's black outline peek
// out around already-sung glyphs; with no base drawn under the sung part
// there is nothing to peek. The time lag keeps the two edges overlapping, so
// no gap can open between them either.

/** How far the base layer's cut-off trails the highlight's leading edge. */
const WIPE_OVERLAP_MS = 80;

/**
 * clip-path inset() clips to the element's line box, but glyph ink is not
 * confined to it: descenders (g, y, j) and the 0.1em outer stroke paint past
 * its bottom, top and side edges. Every clip edge except the moving wipe
 * edge therefore sits this far OUTSIDE the box.
 */
const INK_BLEED = '0.3em';

/** Highlight layer: revealed from the left up to `progress` (0..1). */
function highlightClip(progress: number): string {
  if (progress <= 0) return 'inset(0 100% 0 0)'; // empty region: no ink at all
  if (progress >= 1) return ''; // unclipped: full stroke on every side
  return `inset(-${INK_BLEED} ${((1 - progress) * 100).toFixed(2)}% -${INK_BLEED} -${INK_BLEED})`;
}

/** Base layer: hidden from the left up to `trailing` (0..1). */
function baseClip(trailing: number): string {
  if (trailing <= 0) return '';
  if (trailing >= 1) return 'inset(0 0 0 100%)'; // empty region
  return `inset(-${INK_BLEED} -${INK_BLEED} -${INK_BLEED} ${(trailing * 100).toFixed(2)}%)`;
}

interface Props {
  parsed: ParsedLrc;
  clock: SyncClock;
  offsetMsRef: RefObject<number>;
  ruby: RubyMode;
}

type Slots = [number | null, number | null];

export default function TwoTrackLyrics({ parsed, clock, offsetMsRef, ruby }: Props) {
  const schedule = useMemo(() => scheduleTwoTrack(parsed.lines), [parsed]);
  const [slots, setSlots] = useState<Slots>([null, null]);
  const lineEls = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null]);
  const baseEls = useRef<[HTMLSpanElement | null, HTMLSpanElement | null]>([null, null]);
  const hlEls = useRef<[HTMLSpanElement | null, HTMLSpanElement | null]>([null, null]);

  useEffect(() => {
    let raf = 0;
    const shown: Slots = [null, null];
    const tick = () => {
      const tMs = clock.timeS(performance.now()) * 1000 + (offsetMsRef.current ?? 0);
      let changed = false;
      for (const lane of [0, 1] as const) {
        const st = laneStateAt(schedule, parsed.lines, lane, tMs);
        const idx = st?.entry.index ?? null;
        if (idx !== shown[lane]) {
          shown[lane] = idx;
          changed = true;
        }
        const el = lineEls.current[lane];
        const base = baseEls.current[lane];
        const hl = hlEls.current[lane];
        // The element for a freshly assigned line mounts on the next render;
        // until then there is nothing to style.
        if (el && st && idx !== null && el.dataset['index'] === String(idx)) {
          el.style.opacity = st.opacity.toFixed(3);
          if (hl) hl.style.clipPath = highlightClip(st.progress);
          if (base) {
            base.style.clipPath = baseClip(
              wipeProgress(parsed.lines[idx]!, st.entry, tMs - WIPE_OVERLAP_MS),
            );
          }
        }
      }
      if (changed) setSlots([shown[0], shown[1]]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [schedule, parsed, clock, offsetMsRef]);

  // Text never resizes while shown, but an over-long line is shrunk once,
  // before its first frame, so it fits the lane on one row.
  useLayoutEffect(() => {
    for (const lane of [0, 1] as const) {
      const el = lineEls.current[lane];
      if (!el) continue;
      el.style.fontSize = '';
      const room = el.parentElement?.clientWidth ?? 0;
      const need = el.scrollWidth;
      if (room > 0 && need > room) {
        const base = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${Math.max(base * 0.45, base * (room / need) * 0.98)}px`;
      }
    }
  }, [slots]);

  return (
    <div className={`twotrack ${ruby !== 'none' ? 'has-ruby' : ''}`}>
      {([0, 1] as const).map((lane) => {
        const idx = slots[lane];
        const line = idx === null ? undefined : parsed.lines[idx];
        return (
          <div key={lane} className="tt-lane">
            {line && idx !== null && (
              <div
                key={idx}
                className="tt-line"
                data-index={idx}
                style={{ opacity: 0 }}
                ref={(el) => {
                  lineEls.current[lane] = el;
                }}
              >
                <span
                  className="tt-text base"
                  ref={(el) => {
                    baseEls.current[lane] = el;
                  }}
                >
                  <Segments segments={annotate(line.text, ruby)} />
                </span>
                <span
                  className="tt-text hl"
                  aria-hidden
                  ref={(el) => {
                    hlEls.current[lane] = el;
                  }}
                >
                  <Segments segments={annotate(line.text, ruby)} />
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Segments({ segments }: { segments: RubySegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.ruby ? (
          <span key={i} className="tt-seg">
            <span className="tt-ruby">{s.ruby}</span>
            {s.base}
          </span>
        ) : (
          <span key={i}>{s.base}</span>
        ),
      )}
    </>
  );
}
