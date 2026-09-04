import { useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  type AppInfo,
  type ProviderId,
  type Settings,
  type SettingsPatch,
} from '../../shared/ipc';

// Settings modal (SPEC.md §7): provider toggles, Ollama endpoint/model,
// cache folder info. Changes save immediately (toggles) or on blur/Enter
// (text fields); main returns the effective settings after each write.

interface Props {
  appInfo: AppInfo | null;
  onClose(): void;
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  lrclib: 'LRCLIB (community synced-lyrics DB)',
  netease: 'NetEase Cloud Music (large CJK library, unofficial)',
};

export default function SettingsModal({ appInfo, onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    window.karaoke
      .settingsGet()
      .then((s) => {
        setSettings(s);
        setEndpoint(s.ollama.endpoint);
        setModel(s.ollama.model);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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
    window.karaoke
      .settingsSet(patch)
      .then((s) => {
        setSettings(s);
        setEndpoint(s.ollama.endpoint);
        setModel(s.ollama.model);
        setFlash('Saved');
        setTimeout(() => setFlash(null), 1200);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const saveOllamaText = () => {
    if (!settings) return;
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

        {!settings && !error && <div className="muted">Loading…</div>}

        {settings && (
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
        )}

        <footer className="modal-foot">
          {error && <span className="warning-chip">⚠ {error}</span>}
        </footer>
      </div>
    </div>
  );
}
