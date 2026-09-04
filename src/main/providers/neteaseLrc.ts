// Pure cleanup for NetEase LRC bodies (kept free of Electron imports so it
// can be unit-tested). NetEase prefixes lyrics with timed credit lines such
// as "[00:00.000] 作词 : Ayase" and marks instrumentals with a single
// "纯音乐，请欣赏" line — neither is something to sing along to.

const CREDIT_LINE =
  /^\s*(?:\[[^\]]*\]\s*)+(?:作词|作曲|编曲|制作人|作詞|編曲|词|曲|监制|製作人|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|Lyrics?\s*by|Composed\s*by|Arranged\s*by|Produced\s*by|Written\s*by|Lyricist|Composer|Arranger|Producer|OP|SP|Original\s*Publisher)\s*[:：]/i;

const INSTRUMENTAL_LINE = /纯音乐|純音樂|无歌词|無歌詞|instrumental/i;

/** Number of lines that carry a timestamp and non-empty text. */
export function countTimedTextLines(lrc: string): number {
  return lrc
    .split(/\r?\n/)
    .filter((l) => /^\s*\[\d/.test(l) && l.replace(/\[[^\]]*\]/g, '').trim()).length;
}

/**
 * Strip credit lines and detect empty/instrumental bodies.
 * Returns null when nothing singable remains.
 */
export function cleanNeteaseLrc(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const lines = raw.split(/\r?\n/).filter((l) => !CREDIT_LINE.test(l));
  const body = lines.join('\n').trim();
  if (!body) return null;
  const timed = countTimedTextLines(body);
  if (timed === 0) return null;
  if (timed <= 2 && INSTRUMENTAL_LINE.test(body)) return null;
  return body;
}
