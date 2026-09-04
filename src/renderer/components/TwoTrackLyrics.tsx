import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { RubyMode } from '../../shared/ipc';
import type { ParsedLrc } from '../../shared/lrc';
import type { SyncClock } from '../../shared/syncClock';
import { laneStateAt, scheduleTwoTrack } from '../../shared/twoTrack';
import { annotate, type RubySegment } from '../ruby';

// Joysound-style two-lane display (see shared/twoTrack.ts for the timing
// model). Per frame we read the clock, ask the schedule what each lane shows,
// and poke opacity / wipe clip straight into the DOM — React only re-renders
// when a lane switches to a different line.

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
        const hl = hlEls.current[lane];
        // The element for a freshly assigned line mounts on the next render;
        // until then there is nothing to style.
        if (el && st && el.dataset['index'] === String(idx)) {
          el.style.opacity = st.opacity.toFixed(3);
          if (hl) hl.style.clipPath = `inset(0 ${((1 - st.progress) * 100).toFixed(2)}% 0 0)`;
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
                <span className="tt-text base">
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
