import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, QueueAddMode, ResolveResult } from '../shared/ipc';
import { parseLrc } from '../shared/lrc';
import { SyncClock } from '../shared/syncClock';
import LyricsDisplay, { type LyricsStatus } from './components/LyricsDisplay';
import LyricsInspector from './components/LyricsInspector';
import Player, { type PlayerHandle } from './components/Player';
import QueuePanel from './components/QueuePanel';
import SettingsModal from './components/SettingsModal';
import UrlBar from './components/UrlBar';
import { useQueue } from './useQueue';
import { useSettings } from './useSettings';
import { formatTime } from './youtube';

/** Unplayable video (embed-blocked, removed, …) → move on after this long. */
const AUTO_SKIP_MS = 5000;

export default function App() {
  const clockRef = useRef(new SyncClock());
  const playerRef = useRef<PlayerHandle | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const lyricsMode = settings.display.lyricsMode;

  // The queue's head is what's playing. The Player is keyed by the queue
  // item id (not the video id) so the same song queued twice still remounts.
  const queue = useQueue();
  const { advance: queueAdvance, add: queueAdd } = queue; // stable identities
  const current = queue.items[0] ?? null;
  const currentId = current?.id ?? null;
  const videoId = current?.videoId ?? null;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const currentVideoIdRef = useRef(videoId);
  currentVideoIdRef.current = videoId;

  // The item restored from disk at launch is cued, not autoplayed; every
  // later head change (add, skip, song ended) is user-driven → autoplay.
  const initialIdRef = useRef<number | null | undefined>(undefined);
  if (queue.loaded && initialIdRef.current === undefined) initialIdRef.current = currentId;
  const autoplay = queue.loaded && currentId !== initialIdRef.current;

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
  const [queueOpen, setQueueOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const modalOpen = inspectorOpen || settingsOpen;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modalOpen;
  const [playerState, setPlayerState] = useState('idle');
  const [timeS, setTimeS] = useState(0);
  const [durationS, setDurationS] = useState(0);

  const resolvedWithDurRef = useRef(false);
  const endedRef = useRef(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.karaoke.getAppInfo().then(setAppInfo).catch(console.error);
  }, []);

  const resolve = useCallback((id: string, itemId: number, duration?: number) => {
    window.karaoke
      .resolveVideo(id, duration)
      .then((r) => {
        if (currentIdRef.current !== itemId) return; // head changed meanwhile
        setResult(r);
        setOffsetMs(r.offsetMs);
        setLyricsStatus('done');
      })
      .catch((err: unknown) => {
        if (currentIdRef.current !== itemId) return;
        setLyricsStatus('error');
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  // Per-song reset whenever the queue head changes.
  useEffect(() => {
    clockRef.current.reset();
    setResult(null);
    setLoadError(null);
    setPlayerError(null);
    setPlayerState(videoId ? 'loading' : 'idle');
    setTimeS(0);
    setDurationS(0);
    setOffsetMs(0);
    resolvedWithDurRef.current = false;
    endedRef.current = false;
    if (skipTimer.current) {
      clearTimeout(skipTimer.current);
      skipTimer.current = null;
    }
    if (currentId === null || !videoId) {
      setLyricsStatus('idle');
      return;
    }
    setLyricsStatus('fetching');
    // Usually a cache hit thanks to the queue prefetch; never blocks playback.
    resolve(videoId, currentId);
  }, [currentId, videoId, resolve]);

  const advance = useCallback(() => {
    queueAdvance().catch(console.error);
  }, [queueAdvance]);

  const failPlayback = useCallback(
    (message: string, autoSkip: boolean) => {
      if (!autoSkip) {
        setPlayerError(message);
        return;
      }
      setPlayerError(`${message} Skipping in ${AUTO_SKIP_MS / 1000}s…`);
      if (skipTimer.current) clearTimeout(skipTimer.current);
      skipTimer.current = setTimeout(advance, AUTO_SKIP_MS);
    },
    [advance],
  );

  const addToQueue = useCallback(
    (input: string, mode: QueueAddMode) => {
      setLoadError(null);
      queueAdd(input, mode).catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    },
    [queueAdd],
  );

  // A fresh result from the inspector (source switch, manual paste, edit).
  const adoptResult = useCallback((r: ResolveResult) => {
    if (r.track.videoId !== currentVideoIdRef.current) return; // song changed meanwhile
    setResult(r);
    setLoadError(null);
    setLyricsStatus('done');
  }, []);

  // Hotkeys: Space play/pause; [ / ] nudge offset ∓100ms, Shift ∓500ms, \ resets;
  // i = lyrics inspector. All off while a modal is open (Esc closes it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (modalOpenRef.current) return;

      if (e.key === 'i' && videoId) {
        e.preventDefault();
        setInspectorOpen(true);
        return;
      }
      if (e.key === ' ') {
        if (playerRef.current) {
          e.preventDefault();
          playerRef.current.toggle();
        }
        return;
      }
      if (!videoId) return;

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
    const lang = result?.track.language ? ` · ${result.track.language}` : '';
    return `${label} · ${doc.source}${lang}${result?.fromCache ? ' · cached' : ''}`;
  })();

  const nowPlayingLabel = current
    ? current.track && current.artist
      ? `${current.artist} — ${current.track}`
      : current.title || current.videoId
    : '';

  const lyricsBlock = current && videoId && !playerError && (
    <LyricsDisplay
      key={current.id}
      status={lyricsStatus}
      doc={result?.lyrics ?? null}
      parsed={parsed}
      clock={clockRef.current}
      offsetMsRef={offsetMsRef}
      mode={lyricsMode}
      ruby={settings.display.ruby}
    />
  );
  // Two-track lanes own the bottom 40% of the stage; the scroll window and
  // plain text keep the lower-third gradient box.
  const layerStyle = parsed && lyricsMode === 'twoTrack' ? 'mode-twotrack' : 'mode-window';

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">YouTube Karaoke</span>
        <UrlBar onAdd={addToQueue} />
        <span className="topbar-status">
          {badge && (
            <button
              className="badge clickable"
              title="Lyrics inspector (i): sources, raw LRC, manual paste, edit metadata"
              onClick={() => setInspectorOpen(true)}
            >
              {badge}
            </button>
          )}
          <button
            className="mode-toggle"
            title="Toggle lyrics overlay / panel"
            onClick={() => setDisplayMode((m) => (m === 'overlay' ? 'panel' : 'overlay'))}
          >
            {displayMode === 'overlay' ? '▭ overlay' : '▤ panel'}
          </button>
          <button
            className={`mode-toggle ${queueOpen ? 'active' : ''}`}
            title="Toggle queue sidebar"
            onClick={() => setQueueOpen((o) => !o)}
          >
            ☰ queue{queue.items.length ? ` · ${queue.items.length}` : ''}
          </button>
          <button
            className="mode-toggle"
            title="Settings: providers, Ollama, cache"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
          <span className="time-readout">
            {formatTime(timeS)} / {formatTime(durationS)}
          </span>
        </span>
      </header>

      <div className="content">
        <main className="stage-column">
          <div className="stage">
            {current && videoId ? (
              <Player
                key={current.id}
                videoId={videoId}
                autoplay={autoplay}
                clock={clockRef.current}
                handleRef={playerRef}
                onReady={(dur) => {
                  setDurationS(dur);
                  if (dur > 0 && !resolvedWithDurRef.current) {
                    resolvedWithDurRef.current = true;
                    // Re-resolve with duration: tightens matching, stores it.
                    resolve(videoId, current.id, dur);
                  }
                }}
                onStateChange={(name) => {
                  setPlayerState(name);
                  // Auto-advance exactly once per item (SPEC.md §7).
                  if (name === 'ended' && !endedRef.current) {
                    endedRef.current = true;
                    advance();
                  }
                }}
                onTick={(t, dur) => {
                  setTimeS(t);
                  if (dur > 0) {
                    setDurationS(dur);
                    // A cued (not autoplayed) video reports 0 duration at
                    // ready; pick it up once metadata is in.
                    if (!resolvedWithDurRef.current) {
                      resolvedWithDurRef.current = true;
                      resolve(videoId, current.id, dur);
                    }
                  }
                }}
                onEmbedBlocked={() => {
                  window.karaoke.markEmbedBlocked(videoId).catch(console.error);
                  failPlayback(
                    'This upload blocks embedding — try another upload of this song (e.g. the "Artist - Topic" one).',
                    true,
                  );
                }}
                onError={(code) =>
                  failPlayback(
                    code === -1
                      ? 'Could not load the YouTube player (offline?).'
                      : `YouTube player error ${code} — video unavailable.`,
                    // Never auto-drain the queue on a network failure.
                    code !== -1,
                  )
                }
              />
            ) : (
              <div className="empty-hint">
                {queue.loaded
                  ? 'Queue is empty — paste a YouTube URL above to add a song.'
                  : ''}
              </div>
            )}
            {playerError && (
              <div className="player-error">
                <div>{playerError}</div>
                {queue.items.length > 0 && (
                  <button className="url-load" onClick={advance}>
                    Skip now ⏭
                  </button>
                )}
              </div>
            )}
            {displayMode === 'overlay' && (
              <div className={`lyrics-layer overlay ${layerStyle}`}>{lyricsBlock}</div>
            )}
            {toast && <div className="toast">{toast}</div>}
          </div>
          {displayMode === 'panel' && (
            <div className={`lyrics-layer panel ${layerStyle}`}>{lyricsBlock}</div>
          )}
        </main>

        {queueOpen && (
          <QueuePanel
            items={queue.items}
            playerState={playerState}
            onPlay={(id) => queue.play(id).catch(console.error)}
            onTogglePlay={() => playerRef.current?.toggle()}
            onRemove={(id) => queue.remove(id).catch(console.error)}
            onMove={(id, to) => queue.move(id, to).catch(console.error)}
            onAdvance={advance}
            onClear={() => queue.clear().catch(console.error)}
          />
        )}
      </div>

      {inspectorOpen && current && videoId && (
        <LyricsInspector
          key={current.id}
          videoId={videoId}
          title={current.title}
          status={lyricsStatus}
          result={result}
          onResult={adoptResult}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          appInfo={appInfo}
          settings={settings}
          onSave={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <footer className="statusbar">
        <span className="time-readout">t = {formatTime(timeS)}</span>
        <span className="offset-chip">
          offset {offsetMs >= 0 ? '+' : ''}
          {offsetMs} ms
        </span>
        <span className="state-chip">{playerState}</span>
        {nowPlayingLabel && <span className="now-playing-chip">▶ {nowPlayingLabel}</span>}
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
