import { useCallback, useEffect, useState } from 'react';
import {
  ALIGN_DEVICES,
  PROVIDER_IDS,
  WHISPER_MODELS,
  type AlignDevice,
  type AppInfo,
  type InstallProgress,
  type LyricsMode,
  type ProviderId,
  type RubyMode,
  type Settings,
  type SettingsPatch,
  type UvStatus,
  type WhisperModel,
  type YtDlpStatus,
} from '../../shared/ipc';
import { ipcErrorMessage } from '../ipcError';

// Settings modal (SPEC.md §7): lyrics display style, provider toggles,
// Ollama endpoint/model, yt-dlp (search) status + download, cache folder
// info. Changes save immediately (toggles / radios) or on blur/Enter (text
// fields); the App owns the settings state and hands back whatever main
// returns after each write.

interface Props {
  appInfo: AppInfo | null;
  settings: Settings;
  onSave(patch: SettingsPatch): Promise<Settings>;
  onClose(): void;
}

const MODE_LABEL: Record<LyricsMode, { title: string; hint: string }> = {
  twoTrack: {
    title: 'Two-track (Joysound style)',
    hint: 'Two fixed lanes in the bottom 40% of the video; lines fade in ~3 s early and are highlighted with a left-to-right wipe.',
  },
  scroll: {
    title: 'Scroll window',
    hint: 'Previous / current / next lines centred in the lower third.',
  },
};

const RUBY_LABEL: Record<RubyMode, string> = {
  none: 'None',
  furigana: 'Furigana',
  romaji: 'Romaji',
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  lrclib: 'LRCLIB (community synced-lyrics DB)',
  netease: 'NetEase Cloud Music (large CJK library, unofficial)',
};

const ORIGIN_LABEL: Record<NonNullable<YtDlpStatus['origin']>, string> = {
  settings: 'custom path',
  managed: 'app-managed copy',
  path: 'found on PATH',
};

const WHISPER_HINT: Record<WhisperModel, string> = {
  'large-v3': 'best quality, ~3 GB download, slowest',
  'large-v3-turbo': 'near large-v3 quality, ~1.6 GB, faster',
  medium: 'good, ~1.5 GB, faster',
  small: 'rough, ~0.5 GB, fastest',
};

const DEVICE_LABEL: Record<AlignDevice, string> = {
  auto: 'Auto — Demucs on the Apple GPU, Whisper on CPU',
  cpu: 'CPU only',
};

export default function SettingsModal({ appInfo, settings, onSave, onClose }: Props) {
  const [endpoint, setEndpoint] = useState(settings.ollama.endpoint);
  const [model, setModel] = useState(settings.ollama.model);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (patch: SettingsPatch) => {
    setError(null);
    onSave(patch)
      .then((s) => {
        setEndpoint(s.ollama.endpoint);
        setModel(s.ollama.model);
        setFlash('Saved');
        setTimeout(() => setFlash(null), 1200);
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const saveOllamaText = () => {
    const patch: SettingsPatch = { ollama: {} };
    if (endpoint.trim() !== settings.ollama.endpoint) patch.ollama!.endpoint = endpoint.trim();
    if (model.trim() !== settings.ollama.model) patch.ollama!.model = model.trim();
    if (Object.keys(patch.ollama!).length) save(patch);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Settings</h2>
          <span className="muted modal-subtitle">{flash ?? ''}</span>
          <button className="qbtn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <section>
          <h3>Lyrics display</h3>
          {(Object.keys(MODE_LABEL) as LyricsMode[]).map((m) => (
            <label key={m} className="check-row radio-row">
              <input
                type="radio"
                name="lyrics-mode"
                checked={settings.display.lyricsMode === m}
                onChange={() => save({ display: { lyricsMode: m } })}
              />
              <span>
                <span className="radio-title">{MODE_LABEL[m].title}</span>
                <span className="muted radio-hint">{MODE_LABEL[m].hint}</span>
              </span>
            </label>
          ))}
          <div className="check-row">
            <span className="muted">Reading aid above the lyrics:</span>
            {(Object.keys(RUBY_LABEL) as RubyMode[]).map((r) => (
              <label key={r} className="inline-radio">
                <input
                  type="radio"
                  name="ruby-mode"
                  checked={settings.display.ruby === r}
                  onChange={() => save({ display: { ruby: r } })}
                />
                <span>{RUBY_LABEL[r]}</span>
              </label>
            ))}
          </div>
          <p className="muted">
            Furigana puts the kana reading over each kanji; Romaji puts a Hepburn reading over
            every Japanese word. Korean lyrics get Revised Romanization in either mode; other
            languages show nothing. In the scroll display the reading is a sub-line under the
            current line. Computed once per song with kuromoji and cached.
          </p>
        </section>

        <section>
          <h3>Lyrics providers</h3>
          <p className="muted">
            Both are tried for every song; the order follows the detected language
            (Japanese/Korean → NetEase first).
          </p>
          {PROVIDER_IDS.map((id) => (
            <label key={id} className="check-row">
              <input
                type="checkbox"
                checked={settings.providers[id]}
                onChange={(e) => save({ providers: { [id]: e.target.checked } })}
              />
              <span>{PROVIDER_LABEL[id]}</span>
            </label>
          ))}
        </section>

        <section>
          <h3>Ollama title parsing (optional)</h3>
          <p className="muted">
            When the heuristic title parser is unsure, ask a local Ollama model for
            artist/track. Never required — any error or timeout falls back to heuristics.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.ollama.enabled}
              onChange={(e) => save({ ollama: { enabled: e.target.checked } })}
            />
            <span>Enable Ollama assist</span>
          </label>
          <div className="insp-meta">
            <label className="field">
              <span>Endpoint</span>
              <input
                value={endpoint}
                placeholder="http://localhost:11434"
                onChange={(e) => setEndpoint(e.target.value)}
                onBlur={saveOllamaText}
                onKeyDown={(e) => e.key === 'Enter' && saveOllamaText()}
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                value={model}
                placeholder="llama3.1"
                onChange={(e) => setModel(e.target.value)}
                onBlur={saveOllamaText}
                onKeyDown={(e) => e.key === 'Enter' && saveOllamaText()}
              />
            </label>
          </div>
        </section>

        <YtDlpSection settings={settings} save={save} />

        <AlignSettingsSection settings={settings} save={save} />

        <section>
          <h3>Cache</h3>
          <p className="muted">
            Metadata, lyrics, offsets and the queue live in one SQLite file:
          </p>
          <pre className="raw-lrc small">
            {appInfo ? `${appInfo.dbPath}  (schema v${appInfo.schemaVersion})` : '…'}
          </pre>
        </section>

        <footer className="modal-foot">
          {error && <span className="warning-chip">⚠ {error}</span>}
        </footer>
      </div>
    </div>
  );
}

/** yt-dlp status, app-managed download/update, and the custom-path override. */
function YtDlpSection({
  settings,
  save,
}: {
  settings: Settings;
  save(patch: SettingsPatch): void;
}) {
  const [status, setStatus] = useState<YtDlpStatus | null>(null);
  const [path, setPath] = useState(settings.ytdlp.path);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    window.karaoke.searchStatus().then(setStatus).catch(console.error);
  }, []);
  useEffect(refresh, [refresh, settings.ytdlp.path]);
  useEffect(() => window.karaoke.onInstallProgress(setProgress), []);

  const install = () => {
    setBusy(true);
    setProgress(null);
    window.karaoke
      .searchInstall()
      .then(setStatus)
      .catch((err: unknown) =>
        setProgress({ phase: 'error', percent: 0, message: ipcErrorMessage(err) }),
      )
      .finally(() => setBusy(false));
  };

  const savePath = () => {
    if (path.trim() !== settings.ytdlp.path) save({ ytdlp: { path: path.trim() } });
  };

  const line = !status
    ? '…'
    : status.available
      ? `✓ yt-dlp ${status.version} · ${status.origin ? ORIGIN_LABEL[status.origin] : ''}`
      : `✗ ${status.error ?? 'not available'}`;

  return (
    <section>
      <h3>Search (yt-dlp)</h3>
      <p className="muted">
        YouTube search and the “Artist - Topic” suggestions run through yt-dlp. The app can
        keep its own copy (downloaded from the official GitHub release into its data folder,
        ~50 MB) or use one you installed — apps started from Finder don’t see your shell
        PATH, so set the full path below if it isn’t found.
      </p>
      <div className={`ytdlp-status ${status && !status.available ? 'bad' : ''}`}>
        <span>{line}</span>
        {status?.path && <span className="muted ytdlp-path">{status.path}</span>}
      </div>
      <div className="insp-actions">
        <button className="url-load" onClick={install} disabled={busy}>
          {busy
            ? 'Working…'
            : status?.origin === 'managed'
              ? 'Update app-managed yt-dlp'
              : 'Download app-managed yt-dlp'}
        </button>
        {status?.error && status.available && (
          <span className="warning-chip">⚠ {status.error}</span>
        )}
      </div>
      {progress && (
        <div className={`ytdlp-progress ${progress.phase === 'error' ? 'bad' : ''}`}>
          <div>{progress.message}</div>
          {progress.phase !== 'error' && progress.phase !== 'done' && (
            <div className="progress">
              <i style={{ width: `${progress.percent}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="insp-meta">
        <label className="field">
          <span>Custom yt-dlp path (blank = automatic)</span>
          <input
            value={path}
            placeholder="/opt/homebrew/bin/yt-dlp"
            onChange={(e) => setPath(e.target.value)}
            onBlur={savePath}
            onKeyDown={(e) => e.key === 'Enter' && savePath()}
            spellCheck={false}
          />
        </label>
      </div>
    </section>
  );
}

/** Local alignment: uv + Python environment setup, Whisper model, device. */
function AlignSettingsSection({
  settings,
  save,
}: {
  settings: Settings;
  save(patch: SettingsPatch): void;
}) {
  const [status, setStatus] = useState<UvStatus | null>(null);
  const [path, setPath] = useState(settings.uv.path);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [busy, setBusy] = useState<'uv' | 'env' | null>(null);

  const refresh = useCallback(() => {
    window.karaoke.uvStatus().then(setStatus).catch(console.error);
  }, []);
  useEffect(refresh, [refresh, settings.uv.path]);
  useEffect(() => window.karaoke.onEnvProgress(setProgress), []);

  const runTask = (which: 'uv' | 'env', op: () => Promise<UvStatus>) => {
    setBusy(which);
    setProgress(null);
    op()
      .then(setStatus)
      .catch((err: unknown) =>
        setProgress({ phase: 'error', percent: 0, message: ipcErrorMessage(err) }),
      )
      .finally(() => setBusy(null));
  };

  const savePath = () => {
    if (path.trim() !== settings.uv.path) save({ uv: { path: path.trim() } });
  };

  const uvLine = !status
    ? '…'
    : status.available
      ? `✓ uv ${status.version} · ${status.origin ? ORIGIN_LABEL[status.origin] : ''}`
      : `✗ ${status.error ?? 'uv not available'}`;
  const envLine = !status
    ? ''
    : status.envReady
      ? '✓ Python environment ready (torch, Demucs, Whisper)'
      : '○ Python environment not prepared — the first alignment job does it, or prepare it now';

  return (
    <section>
      <h3>Local audio jobs (Whisper)</h3>
      <p className="muted">
        The lyrics inspector’s “Align lyrics”, “Transcribe from audio” and “Auto-offset” run a
        Python worker on this Mac: yt-dlp audio → Demucs vocals → Whisper (stable-ts). The
        worker’s Python and packages are managed by <b>uv</b> in the app’s data folder; Whisper
        model weights download into ~/.cache/whisper on first use.
      </p>
      <div className={`ytdlp-status ${status && !status.available ? 'bad' : ''}`}>
        <span>{uvLine}</span>
        {status?.path && <span className="muted ytdlp-path">{status.path}</span>}
        {envLine && <span className={status?.envReady ? '' : 'muted'}>{envLine}</span>}
        {status && <span className="muted ytdlp-path">{status.envDir}</span>}
      </div>
      <div className="insp-actions">
        <button
          className="url-load"
          disabled={busy !== null}
          onClick={() => runTask('uv', () => window.karaoke.uvInstall())}
        >
          {busy === 'uv'
            ? 'Working…'
            : status?.origin === 'managed'
              ? 'Update app-managed uv'
              : 'Download app-managed uv'}
        </button>
        <button
          className="url-load"
          disabled={busy !== null || !status?.available}
          onClick={() => runTask('env', () => window.karaoke.envPrepare())}
        >
          {busy === 'env' ? 'Preparing…' : status?.envReady ? 'Re-sync environment' : 'Prepare Python environment (~600 MB)'}
        </button>
      </div>
      {progress && (
        <div className={`ytdlp-progress ${progress.phase === 'error' ? 'bad' : ''}`}>
          <div>{progress.message}</div>
          {progress.phase !== 'error' && progress.phase !== 'done' && progress.phase !== 'sync' && (
            <div className="progress">
              <i style={{ width: `${progress.percent}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="insp-meta">
        <label className="field">
          <span>Whisper model</span>
          <select
            value={settings.align.model}
            onChange={(e) => save({ align: { model: e.target.value as WhisperModel } })}
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m} value={m}>
                {m} — {WHISPER_HINT[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Compute device</span>
          <select
            value={settings.align.device}
            onChange={(e) => save({ align: { device: e.target.value as AlignDevice } })}
          >
            {ALIGN_DEVICES.map((d) => (
              <option key={d} value={d}>
                {DEVICE_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Custom uv path (blank = automatic)</span>
          <input
            value={path}
            placeholder="/opt/homebrew/bin/uv"
            onChange={(e) => setPath(e.target.value)}
            onBlur={savePath}
            onKeyDown={(e) => e.key === 'Enter' && savePath()}
            spellCheck={false}
          />
        </label>
      </div>
    </section>
  );
}
