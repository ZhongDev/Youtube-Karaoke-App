import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LyricsDoc, LyricsKind, ResolveResult } from '../../shared/ipc';
import type { LyricsStatus } from './LyricsDisplay';

// Lyrics inspector modal (SPEC.md §7): raw LRC view, switch the active
// source, paste manual lyrics/LRC, edit artist/track (→ re-fetch), re-fetch.
// Every mutation returns a fresh ResolveResult which the App adopts.

interface Props {
  videoId: string;
  title: string;
  status: LyricsStatus;
  result: ResolveResult | null;
  onResult(r: ResolveResult): void;
  onClose(): void;
}

const KIND_LABEL: Record<LyricsKind, string> = {
  synced_word: 'word-synced',
  synced_line: 'line-synced',
  plain: 'plain',
};

export default function LyricsInspector(props: Props) {
  const { videoId, title, status, result, onResult, onClose } = props;
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
