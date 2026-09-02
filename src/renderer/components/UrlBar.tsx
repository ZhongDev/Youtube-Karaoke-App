import { useState, type KeyboardEvent } from 'react';
import type { QueueAddMode } from '../../shared/ipc';

interface Props {
  /** Called once per pasted URL/id. Several may be pasted separated by spaces. */
  onAdd(input: string, mode: QueueAddMode): void;
}

/** Add-to-queue bar. Enter = add to end, Shift+Enter = play next. */
export default function UrlBar({ onAdd }: Props) {
  const [value, setValue] = useState('');

  const submit = (mode: QueueAddMode) => {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    // "Play next" inserts at position 1 each time, so add in reverse to keep
    // the pasted order.
    for (const tok of mode === 'next' ? tokens.reverse() : tokens) onAdd(tok, mode);
    setValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit(e.shiftKey ? 'next' : 'end');
  };

  return (
    <form
      className="url-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit('end');
      }}
    >
      <input
        className="url-input"
        type="text"
        placeholder="Paste a YouTube URL or video id… (Enter = add, Shift+Enter = play next)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      <button className="url-load" type="submit" title="Add to end of queue (Enter)">
        Add
      </button>
      <button
        className="url-load"
        type="button"
        title="Play right after the current song (Shift+Enter)"
        onClick={() => submit('next')}
      >
        Play next
      </button>
    </form>
  );
}
