import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatOffset } from '../../shared/autoOffset';

// Offset popover (anchored to the status-bar chip): a slider for the big
// moves (±30 s), an exact millisecond field, nudge buttons, reset, and the
// auto-offset job. Every control applies live; the hotkeys ([ ] { } \) keep
// working while it is open.

/** Slider range. Real-world drifts are intros/outros of up to ~20 s. */
export const OFFSET_RANGE_MS = 30_000;

interface Props {
  offsetMs: number;
  onChange(ms: number): void;
  /** Starts the auto-offset worker job; null when unavailable (no synced lyrics). */
  onAuto: (() => void) | null;
  autoBusy: boolean;
  onClose(): void;
}

export default function OffsetPopover({ offsetMs, onChange, onAuto, autoBusy, onClose }: Props) {
  const [text, setText] = useState(String(offsetMs));
  const [editing, setEditing] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  // The status bar clips its overflow, so the popover is fixed-positioned
  // from the chip's on-screen box instead of absolutely inside the bar.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = root.current?.parentElement;
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  // Follow external changes (hotkeys, auto-offset) unless the field is being typed in.
  useEffect(() => {
    if (!editing) setText(String(offsetMs));
  }, [offsetMs, editing]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const commitText = () => {
    setEditing(false);
    const n = Number(text.trim().replace(/\s*ms$/i, ''));
    if (Number.isFinite(n)) onChange(Math.round(n));
    else setText(String(offsetMs));
  };

  const nudge = (d: number) => onChange(offsetMs + d);
  const clamp = Math.max(-OFFSET_RANGE_MS, Math.min(OFFSET_RANGE_MS, offsetMs));

  return (
    <div
      className="offset-pop"
      ref={root}
      role="dialog"
      aria-label="Lyrics offset"
      style={pos ? { left: pos.left, bottom: pos.bottom } : { visibility: 'hidden' }}
    >
      <div className="offset-pop-head">
        <span>Lyrics offset</span>
        <span className="offset-pop-value">
          {formatOffset(offsetMs)}
          <span className="muted"> · {offsetMs >= 0 ? 'earlier' : 'later'}</span>
        </span>
      </div>
      <input
        type="range"
        min={-OFFSET_RANGE_MS}
        max={OFFSET_RANGE_MS}
        step={100}
        value={clamp}
        onChange={(e) => onChange(Number(e.target.value))}
        title="Drag: ±30 s in 100 ms steps"
      />
      <div className="offset-pop-scale muted">
        <span>−30 s (later)</span>
        <span>0</span>
        <span>+30 s (earlier)</span>
      </div>
      <div className="offset-pop-row">
        <button className="qbtn" onClick={() => nudge(-1000)} title="−1 s">
          −1s
        </button>
        <button className="qbtn" onClick={() => nudge(-100)} title="−100 ms ( [ )">
          −100
        </button>
        <label className="offset-pop-field">
          <input
            value={text}
            inputMode="numeric"
            onFocus={() => setEditing(true)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setText(String(offsetMs));
                (e.target as HTMLInputElement).blur();
              }
            }}
            spellCheck={false}
          />
          <span className="muted">ms</span>
        </label>
        <button className="qbtn" onClick={() => nudge(100)} title="+100 ms ( ] )">
          +100
        </button>
        <button className="qbtn" onClick={() => nudge(1000)} title="+1 s">
          +1s
        </button>
      </div>
      <div className="offset-pop-row">
        <button className="url-load" disabled={offsetMs === 0} onClick={() => onChange(0)} title="Back to 0 ( \\ )">
          Reset to 0
        </button>
        <button
          className="url-load"
          disabled={!onAuto || autoBusy}
          onClick={() => onAuto?.()}
          title={
            onAuto
              ? 'Find the first lyric lines in the opening vocals and set the offset (local Whisper job)'
              : 'Needs time-synced lyrics'
          }
        >
          {autoBusy ? 'Estimating…' : '⏱ Auto-offset'}
        </button>
      </div>
      <div className="muted offset-pop-hint">
        Positive = lyrics earlier, negative = later. Saved per video.
      </div>
    </div>
  );
}
