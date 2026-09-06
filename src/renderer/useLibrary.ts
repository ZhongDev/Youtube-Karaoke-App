import { useEffect, useMemo, useState } from 'react';
import type { LibrarySnapshot } from '../shared/ipc';

// Renderer view of the main-owned library (cached songs + playlists). Main
// pushes a full snapshot on every change; keep only the newest by rev.

const EMPTY: LibrarySnapshot = { rev: -1, songs: [], playlists: [] };

export function useLibrary() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY);

  useEffect(() => {
    let alive = true;
    const accept = (s: LibrarySnapshot) => {
      if (!alive) return;
      setSnapshot((prev) => (prev.rev > s.rev ? prev : s));
    };
    const off = window.karaoke.onLibraryChanged(accept);
    window.karaoke.libraryGet().then(accept).catch(console.error);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const actions = useMemo(
    () => ({
      create: (name: string) => window.karaoke.playlistCreate(name),
      rename: (id: number, name: string) => window.karaoke.playlistRename(id, name),
      remove: (id: number) => window.karaoke.playlistDelete(id),
      add: (id: number, videoId: string) => window.karaoke.playlistAdd(id, videoId),
      removeSong: (id: number, videoId: string) => window.karaoke.playlistRemove(id, videoId),
      move: (id: number, videoId: string, toIndex: number) =>
        window.karaoke.playlistMove(id, videoId, toIndex),
    }),
    [],
  );

  return { songs: snapshot.songs, playlists: snapshot.playlists, loaded: snapshot.rev >= 0, ...actions };
}
