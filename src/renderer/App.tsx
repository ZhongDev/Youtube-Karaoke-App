import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AlignKind,
  AppInfo,
  QueueAddMode,
  QueueItem,
  ResolveResult,
  TopicSuggestion,
} from '../shared/ipc';
import { formatOffset } from '../shared/autoOffset';
import { parseLrc } from '../shared/lrc';
import { SyncClock } from '../shared/syncClock';
import LibraryModal from './components/LibraryModal';
import LyricsDisplay, { type LyricsStatus } from './components/LyricsDisplay';
import LyricsInspector from './components/LyricsInspector';
import OffsetPopover from './components/OffsetPopover';
import Player, { type PlayerHandle } from './components/Player';
import QueuePanel from './components/QueuePanel';
import SearchBar from './components/SearchBar';
import SettingsModal from './components/SettingsModal';
import TvButton from './components/TvButton';
import { ipcErrorMessage } from './ipcError';
import { KIND_LABEL, isAlignActive, overallPercent, useAlign } from './useAlign';
import { useLibrary } from './useLibrary';
import { useQueue } from './useQueue';
import { useRuby } from './useRuby';
import { useSettings } from './useSettings';
import { formatDuration, formatTime } from './youtube';

/** Unplayable video (embed-blocked, removed, …) → move on after this long. */
const AUTO_SKIP_MS = 5000;
/** TV mode hides the pointer after this much stillness. */
const CURSOR_HIDE_MS = 2500;

/** An embed-blocked song: hunting for / found / no Topic alternative. */
type Blocked = 'looking' | 'none' | TopicSuggestion;

function songLabel(item: QueueItem): string {
  return item.track && item.artist ? `${item.artist} — ${item.track}` : item.title || item.videoId;
}

export default function App() {
  const clockRef = useRef(new SyncClock());
  const playerRef = useRef<PlayerHandle | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const lyricsMode = settings.display.lyricsMode;

  // The queue's head is what's playing. One "play" is one queue row playing
  // one video, so the Player is keyed by both: the same song queued twice
  // still remounts, and so does a row whose video was swapped for the Topic
  // upload.
  const queue = useQueue();
  const { advance: queueAdvance, add: queueAdd, replace: queueReplace } = queue; // stable
  const current = queue.items[0] ?? null;
  const currentId = current?.id ?? null;
  const videoId = current?.videoId ?? null;
  const playKey = current ? `${current.id}:${current.videoId}` : null;
  const playKeyRef = useRef(playKey);
  playKeyRef.current = playKey;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const currentVideoIdRef = useRef(videoId);
  currentVideoIdRef.current = videoId;

  // The item restored from disk at launch is cued, not autoplayed; every
  // later head change (add, skip, song ended, Topic swap) is user-driven.
  const initialKeyRef = useRef<string | null | undefined>(undefined);
  if (queue.loaded && initialKeyRef.current === undefined) initialKeyRef.current = playKey;
  const autoplay = queue.loaded && playKey !== initialKeyRef.current;

  const [result, setResult] = useState<ResolveResult | null>(null);
  const [lyricsStatus, setLyricsStatus] = useState<LyricsStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);

  const [offsetMs, setOffsetMs] = useState(0);
  const offsetMsRef = useRef(0);
  offsetMsRef.current = offsetMs;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, ms = 1600) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const [displayMode, setDisplayMode] = useState<'overlay' | 'panel'>('overlay');
  const [queueOpen, setQueueOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [offsetOpen, setOffsetOpen] = useState(false);
  const offsetOpenRef = useRef(false);
  offsetOpenRef.current = offsetOpen;
  const modalOpen = inspectorOpen || settingsOpen || libraryOpen;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modalOpen;
  const [tv, setTv] = useState(false);
  const tvRef = useRef(false);
  tvRef.current = tv;
  const [playerState, setPlayerState] = useState('idle');
  const [timeS, setTimeS] = useState(0);
  const [durationS, setDurationS] = useState(0);

  const resolvedWithDurRef = useRef(false);
  const endedRef = useRef(false);
  const playedRef = useRef(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.karaoke.getAppInfo().then(setAppInfo).catch(console.error);
  }, []);

  const resolve = useCallback((id: string, key: string, duration?: number) => {
    window.karaoke
      .resolveVideo(id, duration)
      .then((r) => {
        if (playKeyRef.current !== key) return; // head changed meanwhile
        setResult(r);
        setOffsetMs(r.offsetMs);
        setLyricsStatus('done');
      })
      .catch((err: unknown) => {
        if (playKeyRef.current !== key) return;
        setLyricsStatus('error');
        setLoadError(ipcErrorMessage(err));
      });
  }, []);

  // Per-song reset whenever the play key changes.
  useEffect(() => {
    clockRef.current.reset();
    setResult(null);
    setLoadError(null);
    setPlayerError(null);
    setBlocked(null);
    setPlayerState(videoId ? 'loading' : 'idle');
    setTimeS(0);
    setDurationS(0);
    setOffsetMs(0);
    resolvedWithDurRef.current = false;
    endedRef.current = false;
    playedRef.current = false;
    setOffsetOpen(false);
    if (skipTimer.current) {
      clearTimeout(skipTimer.current);
      skipTimer.current = null;
    }
    if (!playKey || !videoId) {
      setLyricsStatus('idle');
      return;
    }
    setLyricsStatus('fetching');
    // Usually a cache hit thanks to the queue prefetch; never blocks playback.
    resolve(videoId, playKey);
  }, [playKey, videoId, resolve]);

  const advance = useCallback(() => {
    queueAdvance().catch(console.error);
  }, [queueAdvance]);

  /** (Re)arm the single auto-skip/switch timer. */
  const arm = useCallback((fn: () => void) => {
    if (skipTimer.current) clearTimeout(skipTimer.current);
    skipTimer.current = setTimeout(fn, AUTO_SKIP_MS);
  }, []);

  /** Swap the now-playing row to the suggested Topic upload (same queue slot). */
  const replaceCurrent = useCallback(
    (s: TopicSuggestion) => {
      const id = currentIdRef.current;
      if (id === null) return;
      if (skipTimer.current) {
        clearTimeout(skipTimer.current);
        skipTimer.current = null;
      }
      queueReplace(id, s.videoId, s.durationS ?? undefined).catch(console.error);
    },
    [queueReplace],
  );

  const failPlayback = useCallback(
    (message: string, autoSkip: boolean) => {
      if (!autoSkip) {
        setPlayerError(message);
        return;
      }
      setPlayerError(`${message} Skipping in ${AUTO_SKIP_MS / 1000}s…`);
      arm(advance);
    },
    [advance, arm],
  );

  // Embed-blocked (SPEC.md §3, §8): look for the auto-generated Topic upload
  // and, if one is found, switch to it after a short countdown so the queue
  // keeps flowing hands-free; otherwise skip as before.
  const onEmbedBlocked = useCallback(() => {
    const key = playKeyRef.current;
    const id = currentVideoIdRef.current;
    if (!key || !id) return;
    window.karaoke.markEmbedBlocked(id).catch(console.error);
    setPlayerError('This upload blocks embedding.');
    setBlocked('looking');
    window.karaoke
      .suggestTopic(id)
      .then((s) => {
        if (playKeyRef.current !== key) return;
        if (s) {
          setBlocked(s);
          arm(() => replaceCurrent(s));
        } else {
          setBlocked('none');
          arm(advance);
        }
      })
      .catch(() => {
        if (playKeyRef.current !== key) return;
        setBlocked('none');
        arm(advance);
      });
  }, [advance, arm, replaceCurrent]);

  const addToQueue = useCallback(
    (input: string, mode: QueueAddMode, durationS?: number) => {
      setLoadError(null);
      queueAdd(input, mode, durationS).catch((err: unknown) => {
        setLoadError(ipcErrorMessage(err));
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

  // ── TV mode: mirrors the window's fullscreen state (SPEC.md §7) ──
  useEffect(() => {
    window.karaoke.getFullscreen().then(setTv).catch(console.error);
    return window.karaoke.onFullscreenChanged(setTv);
  }, []);

  const setFullscreen = useCallback((on: boolean, displayId?: number) => {
    window.karaoke.setFullscreen(on, displayId).catch(console.error);
  }, []);

  useEffect(() => {
    if (!tv) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hide = () => document.body.classList.add('cursor-hidden');
    const wake = () => {
      document.body.classList.remove('cursor-hidden');
      if (timer) clearTimeout(timer);
      timer = setTimeout(hide, CURSOR_HIDE_MS);
    };
    wake();
    window.addEventListener('mousemove', wake);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      document.body.classList.remove('cursor-hidden');
    };
  }, [tv]);

  // Clicking the embed moves keyboard focus INTO the cross-origin YouTube
  // iframe, where the window-level hotkeys below never see key events. The
  // parent window receives a `blur` when that happens — pull focus straight
  // back out. Clicks on the YouTube controls still work (they don't need
  // focus), and Space / [ ] / t / Esc keep working from the parent document.
  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        const el = document.activeElement;
        if (el instanceof HTMLIFrameElement) el.blur();
      }, 0);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  /** Apply + persist a new offset for the playing video. */
  const applyOffset = useCallback(
    (next: number, announce: boolean) => {
      if (!videoId) return;
      setOffsetMs(next);
      window.karaoke.setOffset(videoId, next).catch(console.error);
      if (!announce) return;
      const sign = next > 0 ? '+' : '';
      showToast(
        next === 0
          ? 'Offset reset'
          : `Offset ${sign}${next} ms (lyrics ${next > 0 ? 'earlier' : 'later'})`,
      );
    },
    [videoId, showToast],
  );

  // Hotkeys: Space play/pause; [ / ] nudge offset ∓100ms, Shift ∓500ms, \ resets;
  // i = lyrics inspector; l = library; t = TV mode (Esc leaves it). All off
  // while a modal is open (Esc closes it) or while typing in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (modalOpenRef.current) return;

      if (e.key === 't') {
        e.preventDefault();
        setFullscreen(!tvRef.current);
        return;
      }
      if (e.key === 'Escape') {
        if (offsetOpenRef.current) setOffsetOpen(false);
        else if (tvRef.current) setFullscreen(false);
        return;
      }
      if (e.key === 'i' && videoId) {
        e.preventDefault();
        setInspectorOpen(true);
        return;
      }
      if (e.key === 'l') {
        e.preventDefault();
        setLibraryOpen(true);
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
      applyOffset(next, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videoId, setFullscreen, applyOffset]);

  // Library: every cached song, as playlists (button / l).
  const library = useLibrary();

  // Background worker jobs (Phases 5–6): a finished job for the playing song
  // re-resolves it so the new document (or the auto-offset) takes over live.
  const align = useAlign();
  const activeJob = align.jobs.find((j) => isAlignActive(j.stage)) ?? null;
  const currentJob = videoId ? (align.jobs.find((j) => j.videoId === videoId) ?? null) : null;
  const currentJobActive = currentJob !== null && isAlignActive(currentJob.stage);
  const currentJobDoneAt = currentJob?.stage === 'done' ? currentJob.finishedAt : null;
  useEffect(() => {
    if (!currentJobDoneAt || !videoId || !playKey) return;
    resolve(videoId, playKey);
    if (currentJob?.kind === 'offset' && currentJob.offsetMs !== null) {
      showToast(`Auto-offset applied: ${formatOffset(currentJob.offsetMs)}`, 4000);
    }
    // (`currentJob` comes from the same snapshot as currentJobDoneAt.)
  }, [currentJobDoneAt, videoId, playKey, resolve, showToast]); // eslint-disable-line

  const startJob = useCallback(
    (kind: AlignKind) => {
      if (!videoId) return;
      setLoadError(null);
      window.karaoke.alignStart(videoId, kind).catch((err: unknown) => {
        setLoadError(ipcErrorMessage(err));
      });
    },
    [videoId],
  );

  const parsed = useMemo(() => {
    const doc = result?.lyrics;
    if (!doc || doc.kind === 'plain') return null;
    return parseLrc(doc.body);
  }, [result]);

  const rubyDoc = useRuby(
    videoId,
    result?.lyrics ?? null,
    settings.display.ruby,
    result?.track.language ?? null,
  );

  // Drift (SPEC.md §8): the lyrics are timed for a recording of a different
  // length → offer the Topic upload as a one-click switch (never automatic).
  const driftSuggestion = useTopicSuggestion(
    result?.driftS !== null && result?.driftS !== undefined && current && !current.isTopic
      ? videoId
      : null,
  );

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

  const nowPlayingLabel = current ? songLabel(current) : '';
  const upNext = queue.items[1] ?? null;

  const lyricsBlock = current && videoId && !playerError && (
    <LyricsDisplay
      key={playKey}
      status={lyricsStatus}
      doc={result?.lyrics ?? null}
      parsed={parsed}
      clock={clockRef.current}
      offsetMsRef={offsetMsRef}
      mode={lyricsMode}
      rubyDoc={rubyDoc}
    />
  );
  // Two-track lanes own the bottom 40% of the stage; the scroll window and
  // plain text keep the lower-third gradient box.
  const layerStyle = parsed && lyricsMode === 'twoTrack' ? 'mode-twotrack' : 'mode-window';

  return (
    <div className={`shell ${tv ? 'tv' : ''}`}>
      <header className="topbar">
        <span className="brand">YouTube Karaoke</span>
        <SearchBar onAdd={addToQueue} />
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
            title="Library (l): every cached song, recently / most played, your playlists"
            onClick={() => setLibraryOpen(true)}
          >
            ♫ library{library.songs.length ? ` · ${library.songs.length}` : ''}
          </button>
          <TvButton
            tv={tv}
            onEnter={(displayId) => setFullscreen(true, displayId)}
            onExit={() => setFullscreen(false)}
          />
          <button
            className="mode-toggle"
            title="Settings: lyrics display, providers, Ollama, yt-dlp, cache"
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
            {current && videoId && playKey ? (
              <Player
                key={playKey}
                videoId={videoId}
                autoplay={autoplay}
                clock={clockRef.current}
                handleRef={playerRef}
                onReady={(dur) => {
                  setDurationS(dur);
                  if (dur > 0 && !resolvedWithDurRef.current) {
                    resolvedWithDurRef.current = true;
                    // Re-resolve with duration: tightens matching, stores it.
                    resolve(videoId, playKey, dur);
                  }
                }}
                onStateChange={(name) => {
                  setPlayerState(name);
                  // One play per item for the library's recently / most played.
                  if (name === 'playing' && !playedRef.current) {
                    playedRef.current = true;
                    window.karaoke.playRecord(videoId).catch(console.error);
                  }
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
                      resolve(videoId, playKey, dur);
                    }
                  }
                }}
                onEmbedBlocked={onEmbedBlocked}
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
                  ? 'Queue is empty — search for a song or paste a YouTube URL above.'
                  : ''}
              </div>
            )}
            {playerError && (
              <div className="player-error">
                <div>{playerError}</div>
                {blocked === 'looking' && (
                  <div className="muted">
                    Looking for the auto-generated “Artist - Topic” upload of this song…
                  </div>
                )}
                {blocked === 'none' && (
                  <div className="muted">
                    No Topic upload found — skipping in {AUTO_SKIP_MS / 1000} s. Try another
                    upload of this song.
                  </div>
                )}
                {blocked !== null && typeof blocked === 'object' && (
                  <div className="suggest">
                    <div className="muted">
                      Switching to the Topic upload in {AUTO_SKIP_MS / 1000} s:
                    </div>
                    <div className="suggest-title">
                      ♪ {blocked.title}
                      <span className="muted">
                        {' '}
                        · {blocked.channel}
                        {blocked.durationS ? ` · ${formatDuration(blocked.durationS)}` : ''}
                      </span>
                    </div>
                    <button className="url-load" onClick={() => replaceCurrent(blocked)}>
                      Switch now
                    </button>
                  </div>
                )}
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
            {tv && current && (
              <div className="nextup">
                <span className="nextup-now">▶ {nowPlayingLabel}</span>
                {upNext ? (
                  <span className="nextup-next">
                    Next: {songLabel(upNext)}
                    {queue.items.length > 2 ? ` · +${queue.items.length - 2} more` : ''}
                  </span>
                ) : (
                  <span className="nextup-next dim">Last song in the queue</span>
                )}
              </div>
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
          key={playKey}
          videoId={videoId}
          title={current.title}
          status={lyricsStatus}
          result={result}
          job={currentJob}
          settings={settings}
          onSaveSettings={updateSettings}
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
      {libraryOpen && (
        <LibraryModal
          songs={library.songs}
          playlists={library.playlists}
          onQueue={addToQueue}
          onCreate={library.create}
          onRename={library.rename}
          onDelete={library.remove}
          onAdd={library.add}
          onRemoveSong={library.removeSong}
          onMove={library.move}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      <footer className="statusbar">
        <span className="time-readout">t = {formatTime(timeS)}</span>
        <span className="offset-anchor">
          <button
            className={`offset-chip clickable ${offsetOpen ? 'open' : ''}`}
            title="Lyrics offset: click for slider / exact entry / reset ( [ ] nudge, \\ resets)"
            disabled={!videoId}
            onClick={() => setOffsetOpen((o) => !o)}
          >
            offset {offsetMs >= 0 ? '+' : ''}
            {offsetMs} ms
          </button>
          {offsetOpen && videoId && (
            <OffsetPopover
              offsetMs={offsetMs}
              onChange={(ms) => applyOffset(ms, false)}
              onAuto={parsed ? () => startJob('offset') : null}
              autoBusy={currentJobActive}
              onClose={() => setOffsetOpen(false)}
            />
          )}
        </span>
        <span className="state-chip">{playerState}</span>
        {nowPlayingLabel && <span className="now-playing-chip">▶ {nowPlayingLabel}</span>}
        {result?.warning && <span className="warning-chip">⚠ {result.warning}</span>}
        {driftSuggestion && (
          <button
            className="chip-btn"
            title={`Switch this queue slot to “${driftSuggestion.title}” (${driftSuggestion.channel})`}
            onClick={() => replaceCurrent(driftSuggestion)}
          >
            ♪ Use Topic upload
            {driftSuggestion.durationS ? ` (${formatDuration(driftSuggestion.durationS)})` : ''}
          </button>
        )}
        {result?.driftS !== null && result?.driftS !== undefined && parsed && !currentJobActive && (
          <button
            className="chip-btn"
            title="Find the first lyric lines in this video's opening vocals and set the offset (local Whisper job)"
            onClick={() => startJob('offset')}
          >
            ⏱ Auto-offset
          </button>
        )}
        {lyricsStatus === 'done' && !result?.lyrics && !currentJobActive && (
          <button
            className="chip-btn"
            title="Whisper writes word-synced lyrics from the isolated vocals — raw and unedited (local job)"
            onClick={() => startJob('transcribe')}
          >
            🎤 Transcribe from audio
          </button>
        )}
        {loadError && <span className="warning-chip">⚠ {loadError}</span>}
        {activeJob && (
          <span
            className="align-chip"
            title={`${KIND_LABEL[activeJob.kind]} · “${activeJob.title}”${activeJob.source ? ` from ${activeJob.source}` : ''} · Whisper ${activeJob.model}`}
          >
            ⚙ {overallPercent(activeJob)}% · {activeJob.message}
          </span>
        )}
        <span className="muted spacer" />
        <span className="muted">
          {appInfo ? `db v${appInfo.schemaVersion} · ${appInfo.dbPath}` : ''}
        </span>
      </footer>
    </div>
  );
}

/** Topic-upload suggestion for `videoId` (null = not wanted / none found). */
function useTopicSuggestion(videoId: string | null): TopicSuggestion | null {
  const [state, setState] = useState<{ videoId: string; s: TopicSuggestion | null } | null>(
    null,
  );
  useEffect(() => {
    if (!videoId) return;
    let alive = true;
    window.karaoke
      .suggestTopic(videoId)
      .then((s) => alive && setState({ videoId, s }))
      .catch(() => alive && setState({ videoId, s: null }));
    return () => {
      alive = false;
    };
  }, [videoId]);
  return state && state.videoId === videoId ? state.s : null;
}
