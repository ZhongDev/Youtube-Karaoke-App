import { useEffect, useRef, useState } from 'react';
import type { DisplayInfo } from '../../shared/ipc';

// TV mode toggle (SPEC.md §7). With one display it just goes fullscreen; with
// several it asks which one, so the app can be sent to the TV while the
// laptop keeps the desktop.

interface Props {
  tv: boolean;
  onEnter(displayId?: number): void;
  onExit(): void;
}

export default function TvButton({ tv, onEnter, onExit }: Props) {
  const [displays, setDisplays] = useState<DisplayInfo[] | null>(null);
  const [menu, setMenu] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const click = () => {
    if (tv) {
      onExit();
      return;
    }
    window.karaoke
      .displaysList()
      .then((ds) => {
        if (ds.length <= 1) {
          onEnter();
        } else {
          setDisplays(ds);
          setMenu(true);
        }
      })
      .catch(() => onEnter());
  };

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  return (
    <span className="tv-wrap" ref={wrapRef}>
      <button
        className={`mode-toggle ${tv ? 'active' : ''}`}
        title="TV mode: fullscreen with only the video, lyrics and next-up (t · Esc exits)"
        onClick={click}
      >
        📺 TV
      </button>
      {menu && displays && (
        <div className="tv-menu">
          <div className="tv-menu-title">Fullscreen on…</div>
          {displays.map((d) => (
            <button
              key={d.id}
              onClick={() => {
                setMenu(false);
                onEnter(d.id);
              }}
            >
              {d.label}
              <span className="muted">
                {' '}
                {d.width}×{d.height}
                {d.current ? ' · this window' : ''}
                {d.primary ? ' · main' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
