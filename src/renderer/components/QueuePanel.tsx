import { useState, type DragEvent, type MouseEvent } from 'react';
import type { QueueItem, QueueLyricsState } from '../../shared/ipc';
import { gapForHover, gapToFinalIndex } from '../../shared/queueLogic';

// Queue sidebar (SPEC.md §7): now-playing block + drag-reorderable "up next"
// list with per-item lyric badges. Reordering uses native HTML5 drag & drop —
// no library needed for a single vertical list. Index 0 (now playing) is
// pinned; clicking an up-next item jumps the queue to it.

interface Props {
  items: QueueItem[];
  playerState: string;
  onPlay(id: number): void;
  onTogglePlay(): void;
  onRemove(id: number): void;
  onMove(id: number, toIndex: number): void;
  onAdvance(): void;
  onClear(): void;
}

const BADGES: Record<QueueLyricsState, { icon: string; label: string }> = {
  fetching: { icon: '⏳', label: 'fetching' },
  synced_word: { icon: '✓', label: 'word-synced' },
  synced_line: { icon: '✓', label: 'line-synced' },
  plain: { icon: '≈', label: 'plain' },
  none: { icon: '✗', label: 'no lyrics' },
  error: { icon: '⚠', label: 'unavailable' },
};

function formatDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`;
}

function titleOf(item: QueueItem): { primary: string; secondary: string } {
  if (item.lyrics === 'error' && !item.title) {
    return { primary: item.videoId, secondary: 'video info unavailable' };
  }
  if (!item.title) return { primary: 'Loading…', secondary: item.videoId };
  if (item.track && item.artist) return { primary: item.track, secondary: item.artist };
  return { primary: item.title, secondary: item.channel };
}

function Badge({ state }: { state: QueueLyricsState }) {
  const b = BADGES[state];
  return (
    <span className={`qbadge qbadge-${state}`} title={`Lyrics: ${b.label}`}>
      {b.icon} {b.label}
    </span>
  );
}

function Thumb({ videoId }: { videoId: string }) {
  return (
    <img
      className="qthumb"
      src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
      alt=""
      draggable={false}
    />
  );
}

export default function QueuePanel(props: Props) {
  const { items, playerState } = props;
  const [dragId, setDragId] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const head = items[0];
  const upNext = items.slice(1);
  const dragIndex = dragId === null ? -1 : items.findIndex((i) => i.id === dragId);

  const endDrag = () => {
    setDragId(null);
    setGap(null);
  };

  const onDragStart = (e: DragEvent<HTMLLIElement>, id: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    setDragId(id);
  };

  const onDragOverItem = (e: DragEvent<HTMLLIElement>, index: number) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setGap(gapForHover(index, e.clientY - rect.top > rect.height / 2));
  };

  const onDragOverList = (e: DragEvent<HTMLOListElement>) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setGap(items.length); // empty space below the last item
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (dragId !== null && gap !== null && dragIndex >= 0) {
      props.onMove(dragId, gapToFinalIndex(gap, dragIndex));
    }
    endDrag();
  };

  const remove = (e: MouseEvent, id: number) => {
    e.stopPropagation();
    props.onRemove(id);
  };

  const playing = playerState === 'playing' || playerState === 'buffering';

  return (
    <aside className="queue-panel">
      <div className="queue-section-title">Now playing</div>
      {head ? (
        <div
          className="qitem now-playing"
          onClick={props.onTogglePlay}
          title="Click to play / pause (Space)"
        >
          <span className="qmarker">{playing ? '❚❚' : '▶'}</span>
          <Thumb videoId={head.videoId} />
          <div className="qtext">
            <div className="qprimary">{titleOf(head).primary}</div>
            <div className="qsecondary">{titleOf(head).secondary}</div>
          </div>
          <div className="qmeta">
            <Badge state={head.lyrics} />
            <span className="qduration">{formatDuration(head.durationS)}</span>
          </div>
          <button
            className="qbtn"
            title="Skip to next"
            onClick={(e) => {
              e.stopPropagation();
              props.onAdvance();
            }}
          >
            ⏭
          </button>
        </div>
      ) : (
        <div className="queue-empty">Nothing playing — add a song above.</div>
      )}

      <div className="queue-section-title">
        Up next{upNext.length ? ` · ${upNext.length}` : ''}
        <span className="spacer" />
        {items.length > 0 && (
          <button
            className={`qbtn ${confirmClear ? 'danger' : ''}`}
            onClick={() => {
              if (confirmClear) props.onClear();
              setConfirmClear(!confirmClear);
            }}
            onBlur={() => setConfirmClear(false)}
            title="Clear the whole queue"
          >
            {confirmClear ? 'Clear all?' : 'Clear'}
          </button>
        )}
      </div>

      <ol className="queue-list" onDragOver={onDragOverList} onDrop={onDrop}>
        {upNext.map((item, i) => {
          const index = i + 1;
          const { primary, secondary } = titleOf(item);
          const cls = [
            'qitem',
            item.id === dragId ? 'dragging' : '',
            gap === index ? 'drop-before' : '',
            gap === items.length && index === items.length - 1 ? 'drop-after' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={item.id}
              className={cls}
              draggable
              onDragStart={(e) => onDragStart(e, item.id)}
              onDragEnd={endDrag}
              onDragOver={(e) => onDragOverItem(e, index)}
              onDrop={onDrop}
              onClick={() => props.onPlay(item.id)}
              title="Click to play now · drag to reorder"
            >
              <span className="qmarker qindex">{index}</span>
              <Thumb videoId={item.videoId} />
              <div className="qtext">
                <div className="qprimary">{primary}</div>
                <div className="qsecondary">{secondary}</div>
              </div>
              <div className="qmeta">
                <Badge state={item.lyrics} />
                <span className="qduration">{formatDuration(item.durationS)}</span>
              </div>
              <button className="qbtn" title="Remove" onClick={(e) => remove(e, item.id)}>
                ✕
              </button>
            </li>
          );
        })}
        {head && upNext.length === 0 && (
          <li className="queue-empty">Queue ends after this song.</li>
        )}
      </ol>
    </aside>
  );
}
