import { useEffect, useMemo, useState } from 'react';
import type { LibrarySong, Playlist, QueueAddMode } from '../../shared/ipc';
import { allSongs, filterSongs, mostPlayed, recentlyPlayed, songLabel } from '../../shared/library';
import { ipcErrorMessage } from '../ipcError';
import { formatDuration } from '../youtube';

// Library modal: every song the app has cached, as playlists. Three smart
// lists (recently played, most played, all songs) plus the user's own
// playlists (create / rename / delete / add / remove / reorder). Any song
// can be queued (end or next) and a whole list queued in order.

type SmartId = 'recent' | 'most' | 'all';
type Selection = { kind: 'smart'; id: SmartId } | { kind: 'user'; id: number };

const SMART: { id: SmartId; label: string; hint: string }[] = [
  { id: 'recent', label: 'Recently played', hint: 'Latest first' },
  { id: 'most', label: 'Most played', hint: 'By number of plays' },
  { id: 'all', label: 'All songs', hint: 'Everything cached, A–Z' },
];

const LYRICS_MARK: Record<LibrarySong['lyrics'], string> = {
  synced_word: '✓✓',
  synced_line: '✓',
  plain: '≈',
  none: '✗',
};

interface Props {
  songs: LibrarySong[];
  playlists: Playlist[];
  onQueue(videoId: string, mode: QueueAddMode, durationS?: number): void;
  onCreate(name: string): Promise<number>;
  onRename(id: number, name: string): Promise<void>;
  onDelete(id: number): Promise<void>;
  onAdd(id: number, videoId: string): Promise<void>;
  onRemoveSong(id: number, videoId: string): Promise<void>;
  onMove(id: number, videoId: string, toIndex: number): Promise<void>;
  onClose(): void;
}

export default function LibraryModal(props: Props) {
  const { songs, playlists, onQueue, onCreate, onRename, onDelete, onAdd, onRemoveSong, onMove, onClose } =
    props;
  const [sel, setSel] = useState<Selection>({ kind: 'smart', id: 'recent' });
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
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

  // A deleted playlist that was selected falls back to the first smart list.
  useEffect(() => {
    if (sel.kind === 'user' && !playlists.some((p) => p.id === sel.id)) {
      setSel({ kind: 'smart', id: 'recent' });
    }
  }, [playlists, sel]);

  const byId = useMemo(() => new Map(songs.map((s) => [s.videoId, s])), [songs]);
  const userList = sel.kind === 'user' ? (playlists.find((p) => p.id === sel.id) ?? null) : null;

  const listed: LibrarySong[] = useMemo(() => {
    if (sel.kind === 'smart') {
      if (sel.id === 'recent') return recentlyPlayed(songs);
      if (sel.id === 'most') return mostPlayed(songs);
      return allSongs(songs);
    }
    return (userList?.videoIds ?? []).map((v) => byId.get(v)).filter((s): s is LibrarySong => !!s);
  }, [sel, songs, userList, byId]);
  const shown = useMemo(() => filterSongs(listed, query), [listed, query]);

  const run = (op: () => Promise<unknown>, done?: string) => {
    setError(null);
    op()
      .then(() => {
        if (done) {
          setFlash(done);
          setTimeout(() => setFlash(null), 1200);
        }
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    onCreate(name)
      .then((id) => {
        setNewName('');
        setSel({ kind: 'user', id });
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const queueAll = () => {
    for (const s of shown) onQueue(s.videoId, 'end', s.durationS ?? undefined);
    setFlash(`Queued ${shown.length} song${shown.length === 1 ? '' : 's'}`);
    setTimeout(() => setFlash(null), 1500);
  };

  const title =
    sel.kind === 'smart' ? SMART.find((s) => s.id === sel.id)!.label : (userList?.name ?? '');

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal library"
        role="dialog"
        aria-label="Library"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Library</h2>
          <span className="muted modal-subtitle">
            {flash ?? `${songs.length} cached song${songs.length === 1 ? '' : 's'}`}
          </span>
          <button className="qbtn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="lib-body">
          <nav className="lib-nav">
            {SMART.map((s) => (
              <button
                key={s.id}
                className={`lib-nav-item ${sel.kind === 'smart' && sel.id === s.id ? 'active' : ''}`}
                title={s.hint}
                onClick={() => setSel({ kind: 'smart', id: s.id })}
              >
                <span>{s.label}</span>
                <span className="muted">
                  {s.id === 'all' ? songs.length : recentlyPlayed(songs).length}
                </span>
              </button>
            ))}
            <div className="lib-nav-head muted">My playlists</div>
            {playlists.map((p) => (
              <div
                key={p.id}
                className={`lib-nav-item ${sel.kind === 'user' && sel.id === p.id ? 'active' : ''}`}
                onClick={() => setSel({ kind: 'user', id: p.id })}
              >
                {renaming?.id === p.id ? (
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim() && renaming.name.trim() !== p.name) {
                        run(() => onRename(p.id, renaming.name));
                      }
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="lib-nav-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="muted">{p.videoIds.length}</span>
                    <span className="lib-nav-tools">
                      <button
                        className="qbtn"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ id: p.id, name: p.name });
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="qbtn danger"
                        title="Delete playlist"
                        onClick={(e) => {
                          e.stopPropagation();
                          run(() => onDelete(p.id));
                        }}
                      >
                        🗑
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
            <form
              className="lib-new"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <input
                value={newName}
                placeholder="New playlist…"
                onChange={(e) => setNewName(e.target.value)}
                spellCheck={false}
              />
              <button className="qbtn" type="submit" disabled={!newName.trim()} title="Create playlist">
                +
              </button>
            </form>
          </nav>

          <section className="lib-main">
            <div className="lib-toolbar">
              <h3>{title}</h3>
              <input
                className="lib-filter"
                value={query}
                placeholder="Filter…"
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
              <button
                className="url-load"
                disabled={!shown.length}
                title="Append every listed song to the queue, in this order"
                onClick={queueAll}
              >
                Queue all{shown.length ? ` (${shown.length})` : ''}
              </button>
            </div>
            {shown.length === 0 && (
              <div className="muted lib-empty">
                {songs.length === 0
                  ? 'Nothing cached yet — every song you play or queue lands here.'
                  : sel.kind === 'user'
                    ? 'Empty playlist — add songs from any list with “＋ playlist”.'
                    : query
                      ? 'No song matches the filter.'
                      : 'Nothing played yet.'}
              </div>
            )}
            <ul className="lib-list">
              {shown.map((s, i) => (
                <li key={s.videoId} className={`lib-row ${s.embeddable ? '' : 'blocked'}`}>
                  <div className="lib-song">
                    <div className="lib-title" title={s.title}>
                      {songLabel(s)}
                    </div>
                    <div className="muted lib-meta">
                      {s.channel}
                      {s.durationS ? ` · ${formatDuration(s.durationS)}` : ''}
                      {s.isTopic ? ' · Topic' : ''}
                      {!s.embeddable ? ' · blocks embedding' : ''}
                      {s.playCount ? ` · ${s.playCount} play${s.playCount === 1 ? '' : 's'}` : ''}
                      {s.lastPlayedAt ? ` · last ${s.lastPlayedAt.slice(0, 16)}` : ''}
                    </div>
                  </div>
                  <span className={`qbadge qbadge-${s.lyrics}`} title={`Lyrics: ${s.lyrics}`}>
                    {LYRICS_MARK[s.lyrics]}
                  </span>
                  <span className="lib-actions">
                    <button
                      className="qbtn"
                      title="Play next"
                      onClick={() => {
                        onQueue(s.videoId, 'next', s.durationS ?? undefined);
                        setFlash('Playing next');
                        setTimeout(() => setFlash(null), 1200);
                      }}
                    >
                      ▶ next
                    </button>
                    <button
                      className="qbtn"
                      title="Add to the end of the queue"
                      onClick={() => {
                        onQueue(s.videoId, 'end', s.durationS ?? undefined);
                        setFlash('Queued');
                        setTimeout(() => setFlash(null), 1200);
                      }}
                    >
                      + queue
                    </button>
                    {playlists.length > 0 && (
                      <select
                        className="lib-add-select"
                        value=""
                        title="Add to a playlist"
                        onChange={(e) => {
                          const id = Number(e.target.value);
                          if (id) run(() => onAdd(id, s.videoId), 'Added to playlist');
                        }}
                      >
                        <option value="">＋ playlist</option>
                        {playlists
                          .filter((p) => !p.videoIds.includes(s.videoId))
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {userList && (
                      <>
                        <button
                          className="qbtn"
                          title="Move up"
                          disabled={i === 0 || !!query}
                          onClick={() => run(() => onMove(userList.id, s.videoId, i - 1))}
                        >
                          ▲
                        </button>
                        <button
                          className="qbtn"
                          title="Move down"
                          disabled={i === shown.length - 1 || !!query}
                          onClick={() => run(() => onMove(userList.id, s.videoId, i + 1))}
                        >
                          ▼
                        </button>
                        <button
                          className="qbtn danger"
                          title="Remove from this playlist"
                          onClick={() => run(() => onRemoveSong(userList.id, s.videoId))}
                        >
                          −
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="modal-foot">
          {error && <span className="warning-chip">⚠ {error}</span>}
          <span className="muted">
            ✓✓ word-synced · ✓ line-synced · ≈ plain · ✗ no lyrics
          </span>
        </footer>
      </div>
    </div>
  );
}
