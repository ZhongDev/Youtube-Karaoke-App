import { useEffect, useMemo, useState } from 'react';
import type { QueueAddMode, QueueItem, QueueSnapshot } from '../shared/ipc';

// Renderer view of the main-owned queue. Main pushes a full snapshot on every
// change; we keep only the latest one (by rev — the initial queueGet() reply
// can race a push and must not overwrite newer data).

const EMPTY: QueueItem[] = [];

export function useQueue() {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const accept = (s: QueueSnapshot) => {
      if (!alive) return;
      setSnapshot((prev) => (prev && prev.rev >= s.rev ? prev : s));
    };
    const off = window.karaoke.onQueueChanged(accept);
    window.karaoke.queueGet().then(accept).catch(console.error);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const actions = useMemo(
    () => ({
      add: (input: string, mode: QueueAddMode) => window.karaoke.queueAdd(input, mode),
      remove: (id: number) => window.karaoke.queueRemove(id),
      move: (id: number, toIndex: number) => window.karaoke.queueMove(id, toIndex),
      play: (id: number) => window.karaoke.queuePlay(id),
      advance: () => window.karaoke.queueAdvance(),
      clear: () => window.karaoke.queueClear(),
    }),
    [],
  );

  return { items: snapshot?.items ?? EMPTY, loaded: snapshot !== null, ...actions };
}
