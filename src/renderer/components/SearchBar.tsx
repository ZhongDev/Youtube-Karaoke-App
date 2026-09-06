import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { InstallProgress, QueueAddMode, SearchResult } from '../../shared/ipc';
import { classifyInput } from '../../shared/ytSearch';
import { ipcErrorMessage } from '../ipcError';
import { formatDuration, formatViews } from '../youtube';

// Search-or-paste box (SPEC.md §7, Phase 4). URLs / ids go straight to the
// queue (Enter = add, Shift+Enter = play next); anything else is a yt-dlp
// search whose results drop down under the bar. ↑/↓ move, Enter adds the
// highlighted result, Esc closes. When yt-dlp is missing the panel offers
// to download the app-managed copy and then re-runs the search.

interface Props {
  /** Enqueue one video; `durationS` is passed along from search results. */
  onAdd(input: string, mode: QueueAddMode, durationS?: number): void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'searching'; query: string }
  | { kind: 'results'; query: string; results: SearchResult[] }
  | { kind: 'error'; query: string; message: string; missing: boolean }
  | { kind: 'installing'; query: string; progress: InstallProgress | null };

export default function SearchBar({ onAdd }: Props) {
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [cursor, setCursor] = useState(0);
  const [added, setAdded] = useState<Record<string, QueueAddMode>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Bumped per search/close so late replies of superseded searches are dropped. */
  const seq = useRef(0);

  const open = phase.kind !== 'idle';
  const direct = classifyInput(value).kind === 'videos';

  const close = useCallback(() => {
    seq.current++;
    setPhase({ kind: 'idle' });
  }, []);

  const search = useCallback((query: string) => {
    const my = ++seq.current;
    setPhase({ kind: 'searching', query });
    setCursor(0);
    setAdded({});
    window.karaoke
      .search(query)
      .then((results) => {
        if (seq.current === my) setPhase({ kind: 'results', query, results });
      })
      .catch(async (err: unknown) => {
        if (seq.current !== my) return;
        const message = ipcErrorMessage(err);
        let missing = false;
        try {
          missing = !(await window.karaoke.searchStatus()).available;
        } catch {
          /* status unavailable — show the plain error */
        }
        if (seq.current === my) setPhase({ kind: 'error', query, message, missing });
      });
  }, []);

  const install = useCallback(
    (query: string) => {
      const my = ++seq.current;
      setPhase({ kind: 'installing', query, progress: null });
      const off = window.karaoke.onInstallProgress((progress) => {
        if (seq.current === my) setPhase({ kind: 'installing', query, progress });
      });
      window.karaoke
        .searchInstall()
        .then(() => {
          off();
          if (seq.current === my) search(query);
        })
        .catch((err: unknown) => {
          off();
          if (seq.current !== my) return;
          const message = ipcErrorMessage(err);
          setPhase({ kind: 'error', query, message, missing: true });
        });
    },
    [search],
  );

  const add = useCallback(
    (r: SearchResult, mode: QueueAddMode) => {
      onAdd(r.videoId, mode, r.durationS ?? undefined);
      setAdded((a) => ({ ...a, [r.videoId]: mode }));
      inputRef.current?.focus();
    },
    [onAdd],
  );

  const submit = (mode: QueueAddMode) => {
    const input = classifyInput(value);
    if (input.kind === 'empty') return;
    if (input.kind === 'videos') {
      // "Play next" inserts at position 1 each time → add in reverse to keep order.
      for (const id of mode === 'next' ? [...input.ids].reverse() : input.ids) onAdd(id, mode);
      setValue('');
      close();
      return;
    }
    if (phase.kind === 'results' && phase.query === input.query) {
      const r = phase.results[cursor];
      if (r) add(r, mode);
      return;
    }
    search(input.query);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.shiftKey ? 'next' : 'end');
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    if (phase.kind !== 'results' || !phase.results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = phase.results.length;
      setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    }
  };

  // Click outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  useEffect(() => {
    listRef.current
      ?.querySelector('.sr-row.cursor')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, phase]);

  return (
    <form
      ref={formRef}
      className="search-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit('end');
      }}
    >
      <input
        ref={inputRef}
        className="url-input"
        type="text"
        placeholder="Search YouTube, or paste a URL / video id…  (Enter = add · Shift+Enter = play next)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      <button
        className="url-load"
        type="submit"
        title={direct ? 'Add to end of queue (Enter)' : 'Search YouTube (Enter)'}
      >
        {direct ? 'Add' : 'Search'}
      </button>
      {direct && (
        <button
          className="url-load"
          type="button"
          title="Play right after the current song (Shift+Enter)"
          onClick={() => submit('next')}
        >
          Play next
        </button>
      )}

      {open && (
        <div className="search-results" ref={listRef}>
          {phase.kind === 'searching' && (
            <div className="sr-note">Searching YouTube for “{phase.query}”…</div>
          )}
          {phase.kind === 'installing' && (
            <div className="sr-note">
              <div>{phase.progress?.message ?? 'Starting download…'}</div>
              <div className="progress">
                <i style={{ width: `${phase.progress?.percent ?? 0}%` }} />
              </div>
            </div>
          )}
          {phase.kind === 'error' && (
            <div className="sr-note">
              <div className="warning-chip">⚠ {phase.message}</div>
              {phase.missing && (
                <div className="sr-install">
                  <p>
                    Search runs on <b>yt-dlp</b>, which is not installed. The app can download
                    the official macOS build (~50 MB) into its own data folder — nothing else
                    on the system is touched. Or install it yourself
                    (<code>brew install yt-dlp</code>) and point Settings at it.
                  </p>
                  <button
                    type="button"
                    className="url-load"
                    onClick={() => install(phase.query)}
                  >
                    Download yt-dlp
                  </button>
                </div>
              )}
            </div>
          )}
          {phase.kind === 'results' && (
            <>
              <div className="sr-head">
                <span>Results for “{phase.query}”</span>
                <span className="sr-hint">
                  ↑↓ move · Enter add · Shift+Enter play next · Esc close
                </span>
                <button type="button" className="qbtn" onClick={close} title="Close (Esc)">
                  ✕
                </button>
              </div>
              {phase.results.length === 0 && <div className="sr-note">No results.</div>}
              {phase.results.map((r, i) => (
                <div
                  key={r.videoId}
                  className={`sr-row ${i === cursor ? 'cursor' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={(e) => add(r, e.shiftKey ? 'next' : 'end')}
                  title="Click to add · Shift+click to play next"
                >
                  <img
                    className="sr-thumb"
                    src={`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`}
                    alt=""
                    draggable={false}
                  />
                  <div className="sr-text">
                    <div className="sr-title">{r.title}</div>
                    <div className="sr-meta">
                      <span className="sr-channel">{r.channel}</span>
                      {r.isTopic && (
                        <span
                          className="sr-topic"
                          title="Auto-generated Topic upload: studio audio, lyrics sync best"
                        >
                          ♪ Topic
                        </span>
                      )}
                      {!r.embeddable && (
                        <span className="sr-blocked" title="This upload blocked embedding last time">
                          blocked
                        </span>
                      )}
                      {r.durationS !== null && <span>{formatDuration(r.durationS)}</span>}
                      {r.viewCount !== null && <span>{formatViews(r.viewCount)} views</span>}
                    </div>
                  </div>
                  <div className="sr-actions">
                    {added[r.videoId] && (
                      <span className="sr-added">
                        ✓ {added[r.videoId] === 'next' ? 'up next' : 'added'}
                      </span>
                    )}
                    <button
                      type="button"
                      className="qbtn"
                      onClick={(e) => {
                        e.stopPropagation();
                        add(r, 'end');
                      }}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="qbtn"
                      onClick={(e) => {
                        e.stopPropagation();
                        add(r, 'next');
                      }}
                    >
                      Play next
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </form>
  );
}
