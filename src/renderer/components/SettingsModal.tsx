import { useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  type AppInfo,
  type LyricsMode,
  type ProviderId,
  type RubyMode,
  type Settings,
  type SettingsPatch,
} from '../../shared/ipc';

// Settings modal (SPEC.md §7): lyrics display style, provider toggles,
// Ollama endpoint/model, cache folder info. Changes save immediately
// (toggles / radios) or on blur/Enter (text fields); the App owns the
// settings state and hands back whatever main returns after each write.

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
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
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
            Furigana / romaji extraction is Phase 6 work — the two-track display is wired
            for it but shows nothing above the text until then.
          </p>
        </section>

        {
          <>
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

            <section>
              <h3>Cache</h3>
              <p className="muted">
                Metadata, lyrics, offsets and the queue live in one SQLite file:
              </p>
              <pre className="raw-lrc small">
                {appInfo ? `${appInfo.dbPath}  (schema v${appInfo.schemaVersion})` : '…'}
              </pre>
            </section>
          </>
        }

        <footer className="modal-foot">
          {error && <span className="warning-chip">⚠ {error}</span>}
        </footer>
      </div>
    </div>
  );
}
