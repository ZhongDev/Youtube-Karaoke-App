import { useState } from 'react';

export default function UrlBar({ onLoad }: { onLoad(input: string): void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="url-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onLoad(value.trim());
      }}
    >
      <input
        className="url-input"
        type="text"
        placeholder="Paste a YouTube URL or video id…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        spellCheck={false}
      />
      <button className="url-load" type="submit">
        Load
      </button>
    </form>
  );
}
