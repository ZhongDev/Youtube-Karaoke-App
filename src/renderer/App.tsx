import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from '../shared/ipc';
import { formatTime, loadYouTubeApi } from './youtube';

// Phase 0: hardcoded video to prove the IFrame API works end-to-end.
const DEMO_VIDEO_ID = 'dQw4w9WgXcQ';

const PLAYER_STATE_NAMES: Record<number, string> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerState, setPlayerState] = useState('loading api…');
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    window.karaoke.getAppInfo().then(setAppInfo).catch(console.error);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    // The IFrame API replaces its target element, so give it a child div
    // instead of the React-managed node.
    const target = document.createElement('div');
    mount.appendChild(target);

    loadYouTubeApi()
      .then((yt) => {
        if (cancelled) return;
        playerRef.current = new yt.Player(target, {
          videoId: DEMO_VIDEO_ID,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
          events: {
            onReady: (e) => {
              setPlayerState('ready');
              setDuration(e.target.getDuration());
              // getCurrentTime() only refreshes ~every 250ms; Phase 1 layers a
              // proper interpolating sync clock on top of this raw poll.
              pollTimer = setInterval(() => {
                setTime(e.target.getCurrentTime());
                setDuration(e.target.getDuration());
              }, 250);
            },
            onStateChange: (e) => {
              setPlayerState(PLAYER_STATE_NAMES[e.data] ?? `state ${e.data}`);
            },
            onError: (e) => {
              // 101/150 = embedding disabled by uploader (SPEC.md §8).
              const embedBlocked = e.data === 101 || e.data === 150;
              setPlayerError(
                embedBlocked
                  ? 'This upload blocks embedding — try another upload of this song.'
                  : `Player error ${e.data}`,
              );
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPlayerError(String(err));
      });

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      playerRef.current?.destroy();
      playerRef.current = null;
      target.remove();
    };
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">YouTube Karaoke</span>
        <span className="topbar-status">
          {playerState} · {formatTime(time)} / {formatTime(duration)}
        </span>
      </header>

      <div className="content">
        <main className="stage">
          <div className="player-mount" ref={mountRef} />
          {playerError && <div className="player-error">{playerError}</div>}
          <div className="lyrics-placeholder">Lyrics overlay — Phase 1</div>
        </main>

        <aside className="sidebar">
          <h2>Queue</h2>
          <p className="muted">Coming in Phase 2</p>
        </aside>
      </div>

      <footer className="statusbar">
        <span className="time-readout">t = {formatTime(time)}</span>
        <span className="muted">
          {appInfo
            ? `db v${appInfo.schemaVersion} · ${appInfo.dbPath}`
            : 'connecting to db…'}
        </span>
      </footer>
    </div>
  );
}
