import { useEffect, useRef, useState, type RefObject } from 'react';
import type { LyricsDoc } from '../../shared/ipc';
import { lineIndexAt, type ParsedLrc } from '../../shared/lrc';
import type { SyncClock } from '../../shared/syncClock';

export type LyricsStatus = 'idle' | 'fetching' | 'done' | 'error';

interface Props {
  status: LyricsStatus;
  doc: LyricsDoc | null;
  /** Parsed LRC when doc is synced; null for plain/none. */
  parsed: ParsedLrc | null;
  clock: SyncClock;
  offsetMsRef: RefObject<number>;
}

export default function LyricsDisplay({ status, doc, parsed, clock, offsetMsRef }: Props) {
  if (status === 'fetching') {
    return <div className="lyrics-note">Fetching lyrics…</div>;
  }
  if (status === 'error') {
    return <div className="lyrics-note">Lyrics lookup failed — playback unaffected.</div>;
  }
  if (status !== 'done' || !doc) {
    return status === 'done' ? (
      <div className="lyrics-note">No lyrics found for this video.</div>
    ) : null;
  }
  if (!parsed) {
    // Plain lyrics (or LRC that failed to parse): untimed scroll mode.
    return (
      <div className="lyrics-plain">
        <span className="unsynced-tag">UNSYNCED — scroll manually</span>
        <pre>{doc.body}</pre>
      </div>
    );
  }
  return <SyncedLyrics parsed={parsed} clock={clock} offsetMsRef={offsetMsRef} />;
}

function SyncedLyrics({
  parsed,
  clock,
  offsetMsRef,
}: {
  parsed: ParsedLrc;
  clock: SyncClock;
  offsetMsRef: RefObject<number>;
}) {
  const [lineIdx, setLineIdx] = useState(-1);
  const [wordIdx, setWordIdx] = useState(-1);

  // rAF loop: read the clock, update state only when the highlight moves.
  useEffect(() => {
    let raf = 0;
    let lastLine = -2;
    let lastWord = -2;
    const tick = () => {
      const tMs =
        clock.timeS(performance.now()) * 1000 + (offsetMsRef.current ?? 0);
      const li = lineIndexAt(parsed.lines, tMs);
      if (li !== lastLine) {
        lastLine = li;
        setLineIdx(li);
      }
      const words = li >= 0 ? parsed.lines[li]!.words : undefined;
      let wi = -1;
      if (words) {
        for (let i = 0; i < words.length && words[i]!.timeMs <= tMs; i++) wi = i;
      }
      if (wi !== lastWord) {
        lastWord = wi;
        setWordIdx(wi);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [parsed, clock, offsetMsRef]);

  const { lines } = parsed;
  const current = lineIdx >= 0 ? lines[lineIdx] : undefined;
  const window: Array<{ key: number; role: string; text: string }> = [];
  if (lineIdx >= 0) {
    if (lineIdx > 0) {
      window.push({ key: lineIdx - 1, role: 'prev', text: lines[lineIdx - 1]!.text });
    }
    window.push({ key: lineIdx, role: 'current', text: current!.text });
    for (const i of [lineIdx + 1, lineIdx + 2]) {
      if (i < lines.length) window.push({ key: i, role: 'next', text: lines[i]!.text });
    }
  } else {
    // Before the first timestamp: preview the opening lines.
    for (const i of [0, 1]) {
      if (i < lines.length) window.push({ key: i, role: 'next', text: lines[i]!.text });
    }
  }

  return (
    <div className="lyrics-synced">
      {window.map((w) =>
        w.role === 'current' && current?.words ? (
          <div key={w.key} className="lyric-line current">
            {current.words.map((word, i) => (
              <span key={i} className={i <= wordIdx ? 'word sung' : 'word'}>
                {word.text}
              </span>
            ))}
          </div>
        ) : (
          <div key={w.key} className={`lyric-line ${w.role}`}>
            {w.text || ' '}
          </div>
        ),
      )}
    </div>
  );
}
