import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, ResolveResult } from '../shared/ipc';
import { parseLrc } from '../shared/lrc';
import { SyncClock } from '../shared/syncClock';
import { extractVideoId } from '../shared/youtubeUrl';
import LyricsDisplay, { type LyricsStatus } from './components/LyricsDisplay';
import Player from './components/Player';
import UrlBar from './components/UrlBar';
import { formatTime } from './youtube';

export default function App() {
  const clockRef = useRef(new SyncClock());
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const [videoId, setVideoId] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [lyricsStatus, setLyricsStatus] = useState<LyricsStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const [offsetMs, setOffsetMs] = useState(0);
  const offsetMsRef = useRef(0);
  offsetMsRef.current = offsetMs;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [displayMode, setDisplayMode] = useState<'overlay' | 'panel'>('overlay');
  const [playerState, setPlayerState] = useState('idle');
  const [timeS, setTimeS] = useState(0);
  const [durationS, setDurationS] = useState(0);

  useEffect(() => {
    window.karaoke.getAppInfo().then(setAppInfo).catch(console.error);
  }, []);

  const resolve = useCallback((id: string, duration?: number) => {
    window.karaoke
      .resolveVideo(id, duration)
      .then((r) => {
        if (r.track.videoId !== id) return;
        setResult(r);
        setOffsetMs(r.offsetMs);
        setLyricsStatus('done');
      })
      .catch((err: unknown) => {
        setLyricsStatus('error');
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const loadVideo = useCallback(
    (input: string) => {
      const id = extractVideoId(input);
      if (!id) {
        setLoadError('That does not look like a YouTube URL or video id.');
        return;
      }
      clockRef.current.reset();
      setVideoId(id);
      setResult(null);
      setLoadError(null);
      setPlayerError(null);
      setLyricsStatus('fetching');
      setPlayerState('loading');
      setTimeS(0);
      setDurationS(0);
      setOffsetMs(0);
      // Lyrics resolve in parallel — playback is never blocked on them.
      resolve(id);
    },
    [resolve],
  );

  // Offset HUD hotkeys: [ / ] nudge ∓100ms, Shift ∓500ms, \ resets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!videoId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      let next: number | null = null;
      const cur = offsetMsRef.current;
      if (e.key === '[') next = cur - 100;
      else if (e.key === ']') next = cur + 100;
      else if (e.key === '{') next = cur - 500;
      else if (e.key === '}') next = cur + 500;
      else if (e.key === '\\' || e.key === '|') next = 0;
      if (next === null) return;

      e.preventDefault();
      setOffsetMs(next);
      window.karaoke.setOffset(videoId, next).catch(console.error);
      const sign = next > 0 ? '+' : '';
      setToast(
        next === 0
          ? 'Offset reset'
          : `Offset ${sign}${next} ms (lyrics ${next > 0 ? 'earlier' : 'later'})`,
      );
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 1600);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videoId]);

  const parsed = useMemo(() => {
    const doc = result?.lyrics;
    if (!doc || doc.kind === 'plain') return null;
    return parseLrc(doc.body);
  }, [result]);

  const badge = (() => {
    if (!videoId) return null;
    if (lyricsStatus === 'fetching') return '⏳ fetching lyrics';
    if (lyricsStatus === 'error') return '✗ lyrics error';
    const doc = result?.lyrics;
    if (!doc) return '✗ no lyrics';
    const label =
      doc.kind === 'synced_word'
        ? '✓ word-synced'
        : doc.kind === 'synced_line'
          ? '✓ line-synced'
          : '≈ plain (unsynced)';
    return `${label} · ${doc.source}${result?.fromCache ? ' · cached' : ''}`;
  })();

  const lyricsBlock = videoId && !playerError && (
    <LyricsDisplay
      status={lyricsStatus}
      doc={result?.lyrics ?? null}
      parsed={parsed}
      clock={clockRef.current}
      offsetMsRef={offsetMsRef}
    />
  );

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">YouTube Karaoke</span>
        <UrlBar onLoad={loadVideo} />
        <span className="topbar-status">
          {badge && <span className="badge">{badge}</span>}
          <button
            className="mode-toggle"
            title="Toggle lyrics overlay / panel"
            onClick={() => setDisplayMode((m) => (m === 'overlay' ? 'panel' : 'overlay'))}
          >
            {displayMode === 'overlay' ? '▭ overlay' : '▤ panel'}
          </button>
          <span className="time-readout">
            {formatTime(timeS)} / {formatTime(durationS)}
          </span>
        </span>
      </header>

      <div className="content">
        <main className="stage-column">
          <div className="stage">
            {videoId ? (
              <Player
                key={videoId}
                videoId={videoId}
                clock={clockRef.current}
                onReady={(dur) => {
                  setDurationS(dur);
                  // Re-resolve with duration: tightens matching, stores it.
                  resolve(videoId, dur);
                }}
                onStateChange={(name) => setPlayerState(name)}
                onTick={(t, dur) => {
                  setTimeS(t);
                  if (dur) setDurationS(dur);
                }}
                onEmbedBlocked={() => {
                  setPlayerError(
                    'This upload blocks embedding — try another upload of this song (e.g. the "Artist - Topic" one).',
                  );
                  window.karaoke.markEmbedBlocked(videoId).catch(console.error);
                }}
                onError={(code) =>
                  setPlayerError(
                    code === -1
                      ? 'Could not load the YouTube player (offline?).'
                      : `Player error ${code}`,
                  )
                }
              />
            ) : (
              <div className="empty-hint">
                Paste a YouTube URL above to start singing.
              </div>
            )}
            {playerError && <div className="player-error">{playerError}</div>}
            {displayMode === 'overlay' && (
              <div className="lyrics-layer overlay">{lyricsBlock}</div>
            )}
            {toast && <div className="toast">{toast}</div>}
          </div>
          {displayMode === 'panel' && (
            <div className="lyrics-layer panel">{lyricsBlock}</div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span className="time-readout">t = {formatTime(timeS)}</span>
        <span className="offset-chip">
          offset {offsetMs >= 0 ? '+' : ''}
          {offsetMs} ms
        </span>
        <span className="state-chip">{playerState}</span>
        {result?.warning && <span className="warning-chip">⚠ {result.warning}</span>}
        {loadError && <span className="warning-chip">⚠ {loadError}</span>}
        <span className="muted spacer" />
        <span className="muted">
          {appInfo ? `db v${appInfo.schemaVersion} · ${appInfo.dbPath}` : ''}
        </span>
      </footer>
    </div>
  );
}
