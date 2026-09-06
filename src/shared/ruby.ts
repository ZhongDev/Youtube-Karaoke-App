// Reading aids (SPEC.md §7, Phase 6): furigana / romaji for Japanese lyrics,
// Revised Romanization for Korean. Everything here is pure and unit-tested;
// the only external piece is the kuromoji tokenizer (main process), which
// hands `segmentsJa` its tokens.
//
// A line is drawn as a sequence of segments; a segment with `ruby` gets that
// reading centred above its base characters (<ruby><rt>), and the scroll
// display joins the readings into a sub-line under the current line.

import type { RubyMode } from './ipc';

export interface RubySegment {
  base: string;
  ruby?: string;
}

export interface RubyDoc {
  lang: 'ja' | 'ko';
  mode: Exclude<RubyMode, 'none'>;
  /** One entry per parsed LRC line (same index as ParsedLrc.lines). */
  lines: RubySegment[][];
}

/** The subset of a kuromoji token the annotator needs. */
export interface JaToken {
  surface: string;
  /** Katakana reading; null for words the dictionary does not know. */
  reading: string | null;
  /** Part of speech (品詞), e.g. 助詞 for particles. */
  pos: string;
}

// ── kana helpers ──

const KANJI_RE = /[\p{Script=Han}〆]/u;
// hiragana, spacing dakuten marks, katakana, ー (combining marks never occur in NFC text)
const KANA_RE = /[\u3041-\u3096\u309b-\u309e\u30a1-\u30fa\u30fc-\u30fe]/u;

export function hasKanji(s: string): boolean {
  return KANJI_RE.test(s);
}

function isKana(ch: string): boolean {
  return KANA_RE.test(ch);
}

function isAllKana(s: string): boolean {
  return s.length > 0 && [...s].every(isKana);
}

/** Katakana → hiragana (ー and everything else untouched). */
export function kataToHira(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

// ── kana → romaji (Hepburn, wāpuro long vowels: とうきょう → toukyou) ──

const ROMAJI: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  // loanword combinations
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  てぃ: 'ti', でぃ: 'di', でゅ: 'dyu', とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  しぇ: 'she', じぇ: 'je', ちぇ: 'che', つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  いぇ: 'ye',
};

/**
 * Kana (either script) → Hepburn romaji. っ doubles the next consonant
 * (っち → tchi), ん takes an apostrophe before vowels and y (しんや →
 * shin'ya), ー repeats the previous vowel. Anything else passes through.
 */
export function kanaToRomaji(kana: string): string {
  const chars = [...kataToHira(kana)];
  let out = '';
  let sokuon = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === 'っ') {
      sokuon = true;
      continue;
    }
    if (ch === 'ー') {
      const last = out[out.length - 1] ?? '';
      if ('aiueo'.includes(last)) out += last;
      sokuon = false;
      continue;
    }
    const next = chars[i + 1];
    let rom: string | undefined;
    if (next !== undefined && ROMAJI[ch + next] !== undefined) {
      rom = ROMAJI[ch + next];
      i++;
    } else {
      rom = ROMAJI[ch];
    }
    if (rom === undefined) {
      out += ch;
      sokuon = false;
      continue;
    }
    if (ch === 'ん') {
      const after = chars[i + 1];
      const afterRom = after === undefined ? '' : (ROMAJI[after] ?? '');
      rom = /^[aiueoy]/.test(afterRom) ? "n'" : 'n';
    }
    if (sokuon) {
      if (rom.startsWith('ch')) rom = `t${rom}`;
      else if (!/^[aiueo]/.test(rom)) rom = rom[0] + rom;
      sokuon = false;
    }
    out += rom;
  }
  return out;
}

// ── Japanese: token → segments ──

/**
 * Split a token into [kana prefix] [kanji core + reading] [kana suffix], so
 * only the kanji carry ruby: 食べる/タベル → 食(た)べる, 走り出す/ハシリダス →
 * 走り出(はしりだ)す. A token with no kanji is one unannotated segment.
 */
export function splitOkurigana(surface: string, readingHira: string): RubySegment[] {
  if (!hasKanji(surface) || !readingHira) return [{ base: surface }];
  const s = [...surface];
  const r = [...readingHira];
  let pre = 0;
  while (pre < s.length && pre < r.length && isKana(s[pre]!) && kataToHira(s[pre]!) === r[pre]) {
    pre++;
  }
  let suf = 0;
  while (
    suf < s.length - pre &&
    suf < r.length - pre &&
    isKana(s[s.length - 1 - suf]!) &&
    kataToHira(s[s.length - 1 - suf]!) === r[r.length - 1 - suf]
  ) {
    suf++;
  }
  const core = s.slice(pre, s.length - suf).join('');
  const coreReading = r.slice(pre, r.length - suf).join('');
  const out: RubySegment[] = [];
  if (pre) out.push({ base: s.slice(0, pre).join('') });
  if (core) out.push(coreReading ? { base: core, ruby: coreReading } : { base: core });
  if (suf) out.push({ base: s.slice(s.length - suf).join('') });
  return out;
}

/** Romaji of one token; particles は / へ read wa / e. */
export function romajiOf(token: JaToken): string | null {
  if (token.pos === '助詞') {
    if (token.surface === 'は') return 'wa';
    if (token.surface === 'へ') return 'e';
  }
  const reading = token.reading ?? (isAllKana(token.surface) ? token.surface : null);
  return reading === null ? null : kanaToRomaji(reading);
}

function pushMerged(out: RubySegment[], seg: RubySegment): void {
  const last = out[out.length - 1];
  if (!seg.ruby && last && !last.ruby) last.base += seg.base;
  else out.push(seg);
}

/** Segments for a line of Japanese from its kuromoji tokens. */
export function segmentsJa(tokens: JaToken[], mode: 'furigana' | 'romaji'): RubySegment[] {
  const out: RubySegment[] = [];
  for (const t of tokens) {
    if (!t.surface) continue;
    if (!hasKanji(t.surface) && !isAllKana(t.surface)) {
      pushMerged(out, { base: t.surface }); // Latin, digits, punctuation
      continue;
    }
    if (mode === 'furigana') {
      if (!hasKanji(t.surface) || !t.reading) pushMerged(out, { base: t.surface });
      else for (const seg of splitOkurigana(t.surface, kataToHira(t.reading))) pushMerged(out, seg);
    } else {
      const rom = romajiOf(t);
      pushMerged(out, rom ? { base: t.surface, ruby: rom } : { base: t.surface });
    }
  }
  return out;
}

// ── Korean: Revised Romanization ──

const INITIALS = [
  'g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h',
];
const MEDIALS = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we',
  'wi', 'yu', 'eu', 'ui', 'i',
];
/** Coda as pronounced before a consonant / at the end (neutralised). */
const FINALS = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p',
  't', 't', 'ng', 't', 't', 'k', 't', 'p', 't',
];
/** Coda carried over as the next syllable's onset when that syllable starts with ㅇ. */
const LINKED = [
  '', 'g', 'kk', 'ks', 'n', 'nj', 'nh', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm',
  'b', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', '',
];

const F_K = new Set([1, 2, 3, 9, 24]); // ㄱ ㄲ ㄳ ㄺ ㅋ
const F_T = new Set([7, 19, 20, 22, 23, 25, 27]); // ㄷ ㅅ ㅆ ㅈ ㅊ ㅌ ㅎ
const F_P = new Set([14, 17, 18, 26]); // ㄿ ㅂ ㅄ ㅍ
const F_L = new Set([8, 11, 12, 13, 15]); // ㄹ ㄼ ㄽ ㄾ ㅀ
const F_N = new Set([4, 5, 6]); // ㄴ ㄵ ㄶ
const F_H = new Set([27, 6, 15]); // ㅎ ㄶ ㅀ
const I_G = 0, I_N = 2, I_D = 3, I_R = 5, I_M = 6, I_NULL = 11, I_J = 12, I_H = 18;
const M_I = 20;

interface Syllable {
  ini: number;
  med: number;
  fin: number;
}

function decompose(ch: string): Syllable | null {
  const c = ch.codePointAt(0)! - 0xac00;
  if (c < 0 || c >= 11172) return null;
  return { ini: Math.floor(c / 588), med: Math.floor((c % 588) / 28), fin: c % 28 };
}

/**
 * Revised Romanization of a run of Hangul syllables, applying the standard
 * sound changes between neighbours: linking (한국어 hangugeo), nasalisation
 * (국물 gungmul, 입니다 imnida), ㄹ assimilation (신라 silla, 종로 jongno),
 * ㅎ dropping / aspiration (좋아 joa, 좋다 jota, 축하 chuka) and ㄷ/ㅌ + 이
 * palatalisation (같이 gachi).
 */
function romanizeRun(syls: Syllable[]): string {
  const onsets = syls.map((s) => INITIALS[s.ini]!);
  const codas = syls.map((s) => FINALS[s.fin]!);
  for (let i = 0; i + 1 < syls.length; i++) {
    const { fin } = syls[i]!;
    const next = syls[i + 1]!;
    const ni = next.ini;
    if (fin === 0) continue;
    if (ni === I_NULL) {
      if ((fin === 7 || fin === 25) && next.med === M_I) {
        codas[i] = '';
        onsets[i + 1] = fin === 7 ? 'j' : 'ch';
      } else if (fin === 21) {
        codas[i] = 'ng';
      } else {
        codas[i] = '';
        onsets[i + 1] = LINKED[fin]!;
      }
    } else if (ni === I_N || ni === I_M) {
      if (F_K.has(fin)) codas[i] = 'ng';
      else if (F_T.has(fin)) codas[i] = 'n';
      else if (F_P.has(fin)) codas[i] = 'm';
      else if (F_L.has(fin) && ni === I_N) {
        codas[i] = 'l';
        onsets[i + 1] = 'l';
      }
    } else if (ni === I_R) {
      if (F_N.has(fin) || F_L.has(fin)) {
        codas[i] = 'l';
        onsets[i + 1] = 'l';
      } else if (fin === 16 || fin === 21) {
        onsets[i + 1] = 'n';
      } else if (F_K.has(fin)) {
        codas[i] = 'ng';
        onsets[i + 1] = 'n';
      } else if (F_P.has(fin)) {
        codas[i] = 'm';
        onsets[i + 1] = 'n';
      } else if (F_T.has(fin)) {
        codas[i] = 'n';
        onsets[i + 1] = 'n';
      }
    } else if (ni === I_H) {
      if (F_K.has(fin)) {
        codas[i] = '';
        onsets[i + 1] = 'k';
      } else if (fin === 22) {
        codas[i] = '';
        onsets[i + 1] = 'ch';
      } else if (F_T.has(fin) && fin !== 27) {
        codas[i] = '';
        onsets[i + 1] = 't';
      } else if (F_P.has(fin)) {
        codas[i] = '';
        onsets[i + 1] = 'p';
      }
    } else if (F_H.has(fin) && (ni === I_G || ni === I_D || ni === I_J)) {
      onsets[i + 1] = ni === I_G ? 'k' : ni === I_D ? 't' : 'ch';
      codas[i] = fin === 27 ? '' : fin === 6 ? 'n' : 'l';
    }
  }
  return syls.map((s, i) => onsets[i]! + MEDIALS[s.med]! + codas[i]!).join('');
}

/** Romanize every Hangul run in `text`; other characters pass through. */
export function romanizeHangul(text: string): string {
  let out = '';
  let run: Syllable[] = [];
  const flush = () => {
    if (run.length) out += romanizeRun(run);
    run = [];
  };
  for (const ch of text) {
    const syl = decompose(ch);
    if (syl) run.push(syl);
    else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

const HAS_HANGUL = /[가-힣]/u;
/** Leading / trailing punctuation of a word (kept out of its reading). */
const WORD_EDGES = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;

/** Segments for a line of Korean: each space-separated word gets its romanization. */
export function segmentsKo(text: string): RubySegment[] {
  const out: RubySegment[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (!HAS_HANGUL.test(part)) {
      pushMerged(out, { base: part });
      continue;
    }
    const [, lead = '', word = part, trail = ''] = WORD_EDGES.exec(part) ?? [];
    if (lead) pushMerged(out, { base: lead });
    pushMerged(out, { base: word, ruby: romanizeHangul(word) });
    if (trail) pushMerged(out, { base: trail });
  }
  return out;
}

/** The readings of a line joined into one string (scroll display sub-line). */
export function readingLine(segments: RubySegment[], spaced: boolean): string {
  const parts = segments.map((s) => s.ruby ?? s.base);
  return (spaced ? parts.join(' ') : parts.join('')).replace(/\s+/g, ' ').trim();
}
