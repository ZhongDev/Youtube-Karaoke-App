// Script/language detection by Unicode ranges (SPEC.md §5). Deliberately
// simple: it only has to pick a provider order and tag the track, never to
// be linguistically right. Run on the title before fetching, then again on
// the fetched lyrics (more text, more reliable) once they exist.

export type Language = 'en' | 'ja' | 'ko' | 'other';

export const LANGUAGES: readonly Language[] = ['en', 'ja', 'ko', 'other'];

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/gu; // hiragana, katakana, halfwidth kana
const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/gu;
const HAN = /\p{Script=Han}/gu;
const LATIN = /\p{Script=Latin}/gu;

function count(s: string, re: RegExp): number {
  return s.match(re)?.length ?? 0;
}

/**
 * Detect the dominant script of `text`.
 *  - any Hangul (and at least as much as kana) → ko
 *  - any kana → ja (kanji-only Japanese is indistinguishable from Chinese
 *    without a dictionary, so it lands in `other`; kana appears in virtually
 *    all real Japanese lyrics and most titles)
 *  - Han only → other
 *  - Latin → en, anything else → other
 */
export function detectLanguage(text: string): Language {
  const kana = count(text, KANA);
  const hangul = count(text, HANGUL);
  if (hangul && hangul >= kana) return 'ko';
  if (kana) return 'ja';
  if (count(text, HAN)) return 'other';
  if (count(text, LATIN)) return 'en';
  return 'other';
}

/** Lyrics text with LRC timestamps / word tags / metadata tags removed. */
export function stripLrcTags(body: string): string {
  return body
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ' ');
}

/**
 * Track language: the lyrics body decides when there is one (an English
 * cover of a Japanese song has a Japanese title but English lyrics), else
 * the title + channel.
 */
export function detectTrackLanguage(title: string, lyricsBody?: string | null): Language {
  if (lyricsBody && stripLrcTags(lyricsBody).trim().length >= 20) {
    return detectLanguage(stripLrcTags(lyricsBody));
  }
  return detectLanguage(title);
}
