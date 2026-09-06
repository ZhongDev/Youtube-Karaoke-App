import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  WHISPER_MODELS,
  type AlignJob,
  type LyricsDoc,
  type LyricsKind,
  type ResolveResult,
  type Settings,
  type SettingsPatch,
  type UvStatus,
  type WhisperModel,
} from '../../shared/ipc';
import { ipcErrorMessage } from '../ipcError';
import { STAGE_LABEL, isAlignActive, overallPercent } from '../useAlign';
import type { LyricsStatus } from './LyricsDisplay';

// Lyrics inspector modal (SPEC.md §7): raw LRC view, switch the active
// source, paste manual lyrics/LRC, edit artist/track (→ re-fetch), re-fetch,
// and (Phase 5) "Align lyrics" — a background job that turns any stored text
// into word-synced lyrics. Every mutation returns a fresh ResolveResult
// which the App adopts.

interface Props {
  videoId: string;
  title: string;
  status: LyricsStatus;
  result: ResolveResult | null;
  /** This video's alignment job, if one was started this session. */
  job: AlignJob | null;
  settings: Settings;
  onSaveSettings(patch: SettingsPatch): Promise<Settings>;
  onResult(r: ResolveResult): void;
  onClose(): void;
}

const MODEL_HINT: Record<WhisperModel, string> = {
  'large-v3': 'best quality · ~3 GB download · slowest',
  'large-v3-turbo': 'near large-v3 quality · ~1.6 GB · faster',
  medium: 'good · ~1.5 GB · faster',
  small: 'rough · ~0.5 GB · fastest',
};

const KIND_LABEL: Record<LyricsKind, string> = {
  synced_word: 'word-synced',
  synced_line: 'line-synced',
  plain: 'plain',
};

export default function LyricsInspector(props: Props) {
  const { videoId, title, status, result, job, settings, onSaveSettings, onResult, onClose } =
    props;
  const sources = result?.sources ?? [];
  const active = result?.lyrics ?? null;
  const manual = sources.find((d) => d.source === 'manual') ?? null;

  const [artist, setArtist] = useState(result?.track.artist ?? '');
  const [track, setTrack] = useState(result?.track.track ?? '');
  const [metaDirty, setMetaDirty] = useState(false);
  const [viewing, setViewing] = useState<string | null>(active?.source ?? null);
  const [manualText, setManualText] = useState(manual?.body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Follow the result unless the user is mid-edit.
  useEffect(() => {
    if (!metaDirty) {
      setArtist(result?.track.artist ?? '');
      setTrack(result?.track.track ?? '');
    }
  }, [result?.track.artist, result?.track.track, metaDirty]);

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

  const run = async (label: string, op: () => Promise<ResolveResult>) => {
    setBusy(label);
    setError(null);
    try {
      const r = await op();
      if (!alive.current) return;
      onResult(r);
      setViewing(r.lyrics?.source ?? null);
      const m = r.sources.find((d) => d.source === 'manual');
      setManualText(m?.body ?? '');
      setMetaDirty(false);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const saveMeta = (e: FormEvent) => {
    e.preventDefault();
    void run('Re-fetching with edited metadata…', () =>
      window.karaoke.lyricsSetMeta(videoId, artist, track),
    );
  };

  const viewingDoc: LyricsDoc | null =
    (viewing && sources.find((d) => d.source === viewing)) || active;

  const disabled = busy !== null || status === 'fetching';

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal inspector"
        role="dialog"
        aria-label="Lyrics inspector"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Lyrics inspector</h2>
          <span className="muted modal-subtitle" title={title}>
            {title || videoId}
          </span>
          <button className="qbtn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <form className="insp-meta" onSubmit={saveMeta}>
          <label className="field">
            <span>Artist</span>
            <input
              value={artist}
              disabled={disabled}
              onChange={(e) => {
                setArtist(e.target.value);
                setMetaDirty(true);
              }}
            />
          </label>
          <label className="field">
            <span>Track</span>
            <input
              value={track}
              disabled={disabled}
              onChange={(e) => {
                setTrack(e.target.value);
                setMetaDirty(true);
              }}
            />
          </label>
          <div className="insp-actions">
            <button className="url-load" type="submit" disabled={disabled || !track.trim()}>
              Save &amp; re-fetch
            </button>
            <button
              className="mode-toggle"
              type="button"
              disabled={disabled}
              title="Discard provider results and search again"
              onClick={() => void run('Re-fetching…', () => window.karaoke.lyricsRefetch(videoId))}
            >
              ↻ Re-fetch
            </button>
            {result && (
              <span className="chips">
                <span className="chip" title="Detected language">
                  lang: {result.track.language ?? '?'}
                </span>
                <span className="chip" title="Where artist/track came from">
                  meta: {result.track.metaSource ?? '—'}
                </span>
                {result.track.durationS && <span className="chip">{result.track.durationS}s</span>}
              </span>
            )}
          </div>
        </form>

        <section className="insp-sources">
          <h3>Sources</h3>
          {status === 'fetching' && <div className="lyrics-note">Fetching lyrics…</div>}
          {status !== 'fetching' && sources.length === 0 && (
            <div className="muted">No lyrics stored for this video yet.</div>
          )}
          {sources.length > 0 && (
            <ul className="source-list">
              <li className={`source-row ${result?.activeSource === null ? 'active' : ''}`}>
                <label>
                  <input
                    type="radio"
                    name="active-source"
                    checked={result?.activeSource === null}
                    disabled={disabled}
                    onChange={() =>
                      void run('Switching…', () => window.karaoke.lyricsSetActive(videoId, null))
                    }
                  />
                  <span className="source-name">auto</span>
                  <span className="muted">best by rank</span>
                </label>
              </li>
              {sources.map((d) => (
                <li
                  key={d.source}
                  className={`source-row ${result?.activeSource === d.source ? 'active' : ''} ${
                    viewingDoc?.source === d.source ? 'viewing' : ''
                  }`}
                >
                  <label>
                    <input
                      type="radio"
                      name="active-source"
                      checked={result?.activeSource === d.source}
                      disabled={disabled}
                      onChange={() =>
                        void run('Switching…', () =>
                          window.karaoke.lyricsSetActive(videoId, d.source),
                        )
                      }
                    />
                    <span className="source-name">{d.source}</span>
                    <span className={`qbadge qbadge-${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                    {d.providerDurationS !== null && (
                      <span className="muted">{d.providerDurationS}s</span>
                    )}
                    {active?.source === d.source && <span className="chip">in use</span>}
                  </label>
                  <button
                    className="qbtn"
                    type="button"
                    title="View raw text"
                    onClick={() => setViewing(d.source)}
                  >
                    view
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {viewingDoc && (
          <section className="insp-raw">
            <h3>
              Raw · {viewingDoc.source} · {KIND_LABEL[viewingDoc.kind]}
            </h3>
            <pre className="raw-lrc">{viewingDoc.body}</pre>
          </section>
        )}

        <AlignSection
          videoId={videoId}
          sources={sources}
          defaultSource={viewingDoc?.source ?? active?.source ?? null}
          job={job}
          settings={settings}
          onSaveSettings={onSaveSettings}
          disabled={status === 'fetching'}
        />

        <section className="insp-manual">
          <h3>Manual lyrics</h3>
          <textarea
            className="manual-box"
            placeholder="Paste plain lyrics or a full LRC file here. Timestamps are detected automatically."
            value={manualText}
            disabled={disabled}
            onChange={(e) => setManualText(e.target.value)}
            spellCheck={false}
          />
          <div className="insp-actions">
            <button
              className="url-load"
              type="button"
              disabled={disabled || !manualText.trim()}
              onClick={() =>
                void run('Saving…', () => window.karaoke.lyricsSetManual(videoId, manualText))
              }
            >
              Save as manual source
            </button>
            {manual && (
              <button
                className="qbtn danger"
                type="button"
                disabled={disabled}
                onClick={() => void run('Removing…', () => window.karaoke.lyricsSetManual(videoId, ''))}
              >
                Remove manual
              </button>
            )}
          </div>
        </section>

        <footer className="modal-foot">
          {busy && <span className="muted">⏳ {busy}</span>}
          {error && <span className="warning-chip">⚠ {error}</span>}
        </footer>
      </div>
    </div>
  );
}

/**
 * "Align lyrics" (SPEC.md §5 Tier 3): pick the reference text + Whisper
 * model, start the background job, watch its progress, cancel. The result
 * lands as source "aligned" and the App re-resolves the song by itself.
 */
function AlignSection({
  videoId,
  sources,
  defaultSource,
  job,
  settings,
  onSaveSettings,
  disabled,
}: {
  videoId: string;
  sources: LyricsDoc[];
  defaultSource: string | null;
  job: AlignJob | null;
  settings: Settings;
  onSaveSettings(patch: SettingsPatch): Promise<Settings>;
  disabled: boolean;
}) {
  const candidates = sources.filter((d) => d.source !== 'aligned');
  const [source, setSource] = useState<string>(
    defaultSource && defaultSource !== 'aligned' ? defaultSource : (candidates[0]?.source ?? ''),
  );
  const [uv, setUv] = useState<UvStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = job !== null && isAlignActive(job.stage);

  useEffect(() => {
    window.karaoke.uvStatus().then(setUv).catch(console.error);
  }, [job?.stage]);

  useEffect(() => {
    if (!candidates.some((d) => d.source === source)) setSource(candidates[0]?.source ?? '');
  }, [candidates, source]);

  const start = () => {
    setError(null);
    window.karaoke.alignStart(videoId, source).catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const ready = uv?.available && uv.envReady;

  return (
    <section className="insp-align">
      <h3>Align lyrics locally</h3>
      <p className="muted">
        Generates word-synced lyrics on this Mac: the audio is fetched with yt-dlp, the vocals
        isolated with Demucs, then Whisper (stable-ts) aligns the chosen text to them. Runs in
        the background — playback keeps working.
      </p>
      {uv && !ready && !active && (
        <p className="warning-chip align-note">
          {!uv.available
            ? '⚠ uv is not set up — Settings → Local alignment (one-click download).'
            : '⚠ The Python environment is not prepared yet — the first job sets it up (~600 MB) before starting, or use Settings → Local alignment.'}
        </p>
      )}
      <div className="insp-actions align-controls">
        <label className="field compact">
          <span>Reference text</span>
          <select
            value={source}
            disabled={disabled || active || !candidates.length}
            onChange={(e) => setSource(e.target.value)}
          >
            {candidates.map((d) => (
              <option key={d.source} value={d.source}>
                {d.source} · {KIND_LABEL[d.kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact">
          <span>Whisper model</span>
          <select
            value={settings.align.model}
            disabled={active}
            onChange={(e) => void onSaveSettings({ align: { model: e.target.value as WhisperModel } })}
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m} value={m}>
                {m} — {MODEL_HINT[m]}
              </option>
            ))}
          </select>
        </label>
        {!active && (
          <button
            className="url-load"
            type="button"
            disabled={disabled || !source || !candidates.length}
            onClick={start}
          >
            {job?.stage === 'done' ? 'Align again' : 'Align lyrics'}
          </button>
        )}
        {active && (
          <button
            className="qbtn danger"
            type="button"
            onClick={() => void window.karaoke.alignCancel(videoId)}
          >
            Cancel
          </button>
        )}
      </div>
      {job && (
        <div className={`align-status align-${job.stage}`}>
          <div className="align-line">
            <span className="align-stage">{STAGE_LABEL[job.stage]}</span>
            <span className="muted align-msg">{job.message}</span>
            {active && <span className="align-pct">{overallPercent(job)}%</span>}
          </div>
          {active && (
            <div className="progress">
              <i style={{ width: `${overallPercent(job)}%` }} />
            </div>
          )}
          {job.stage === 'done' && (
            <div className="muted">
              Stored as source “aligned” (word-synced) from {job.source} with {job.model}; it is
              now the active lyrics.
            </div>
          )}
          {job.warnings.length > 0 && (
            <ul className="align-warnings">
              {job.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="warning-chip align-note">⚠ {error}</div>}
    </section>
  );
}
