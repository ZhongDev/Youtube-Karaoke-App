// Heuristic YouTube title → { artist, track } candidates (SPEC.md §6).
//
// Returns candidates ordered by confidence. The lyrics service tries them in
// order against providers, which is how the Artist–Title vs Title–Artist
// ambiguity is resolved (swap candidates are always included). Mixed-script
// JP/KR conventions (「」 quotes, 【MV】 decorations, paren alt-names) are
// first-class — see the test fixtures.

import { diceSimilarity } from './fuzzy';

export interface TitleGuess {
  artist: string;
  track: string;
  confidence: number;
}

const SEPARATORS = [' - ', ' – ', ' — ', ' − ', ' _ ', ' / ', ' | ', '|'] as const;

// NFKC maps fullwidth （）［] to ASCII; 【】 survives and is handled directly.
const BRACKET_RES = [/\(([^()]*)\)/g, /\[([^\][]*)\]/g, /【([^【】]*)】/g] as const;

// A bracketed segment is dropped entirely when its content matches this.
// Content that names the song (alt-script names, subtitle translations) must
// NOT match — e.g. "(방탄소년단)", "(Spring Day)", "(블루밍)".
const BRACKET_NOISE =
  /official|video|audio|lyric|visuali[sz]er|remaster|^m?\/?v$|^mv\b|\bpv\b|4k|8k|\bhd\b|\bhq\b|\blive\b|color coded|dance practice|performance|teaser|eng sub|sub esp|romaji|romanized|karaoke|full ver|\bfeat\.?|\bft\.?\s|featuring|アニメ|主題歌|テーマ|オープニング|エンディング|挿入歌|歌詞|字幕|ミュージックビデオ|가사|안무|뮤직비디오|공식/i;

// Standalone tokens stripped repeatedly from the ends of a fragment.
const EDGE_NOISE =
  /^(official|music|video|audio|lyrics?|mv|m\/v|pv|hd|hq|4k|8k|full|ver\.?|version|teaser|topic|shorts?)$/i;

const FEAT_TAIL = /\s+(feat\.?|ft\.?|featuring)\s+.+$/i;

const QUOTE_RES = [
  /「([^」]+)」/,
  /『([^』]+)』/,
  /(?:^|\s)'([^']+)'(?=\s|$)/,
  /(?:^|\s)‘([^’]+)’(?=\s|$)/,
  /(?:^|\s)"([^"]+)"(?=\s|$)/,
  /(?:^|\s)“([^”]+)”(?=\s|$)/,
] as const;

function normalizeTitle(raw: string): string {
  return raw.normalize('NFKC').replace(/[ \u00A0\u3000]/g, ' '); // NBSP + ideographic space
}

function stripNoiseBrackets(s: string): string {
  let out = s;
  let changed = true;
  while (changed) {
    const before = out;
    for (const re of BRACKET_RES) {
      out = out.replace(re, (full, inner: string) =>
        inner.trim() === '' || BRACKET_NOISE.test(inner) ? ' ' : full,
      );
    }
    changed = out !== before;
  }
  return out;
}

function stripEdgeNoise(s: string): string {
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && EDGE_NOISE.test(tokens[tokens.length - 1]!)) tokens.pop();
  while (tokens.length && EDGE_NOISE.test(tokens[0]!)) tokens.shift();
  return tokens.join(' ');
}

function tidy(s: string): string {
  return s
    .replace(/#\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—−_/|・:]+/, '')
    .replace(/[\s\-–—−_/|・:]+$/, '')
    .trim();
}

const WRAPPING_QUOTES: Array<[string, string]> = [
  ["'", "'"],
  ['‘', '’'],
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
];

function unwrapQuotes(s: string): string {
  for (const [open, close] of WRAPPING_QUOTES) {
    if (s.length > 1 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function cleanFragment(s: string): string {
  return unwrapQuotes(tidy(stripEdgeNoise(tidy(s)).replace(FEAT_TAIL, '')));
}

/** Whole title cleaned for a raw q= provider search. */
export function cleanTitleForSearch(raw: string): string {
  return cleanFragment(stripNoiseBrackets(normalizeTitle(raw)));
}

/**
 * Search variants of a name that carries an alt-script form in brackets —
 * K-pop especially: "Blueming(블루밍)" → ["Blueming(블루밍)", "Blueming",
 * "블루밍"], "봄날 (Spring Day)" → [full, "봄날", "Spring Day"]. Providers
 * try them in order and match against all of them. No brackets → [name].
 */
export function titleVariants(name: string): string[] {
  const full = name.trim();
  const out = full ? [full] : [];
  const m = /^(.*?)\s*[(（【[]([^()（）【】[\]]+)[)）】\]]$/.exec(full);
  if (m && m[1]!.trim()) {
    for (const v of [tidy(m[1]!), tidy(m[2]!)]) {
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** Best fuzzy match of `s` against any variant (see titleVariants). */
export function bestSimilarity(variants: string[], s: string): number {
  return variants.reduce((best, v) => Math.max(best, diceSimilarity(v, s)), 0);
}

/** Channel name → plausible artist ("XVEVO", "X - Topic", "X Official"…). */
export function cleanChannelName(ch: string): string {
  let s = normalizeTitle(ch)
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '');
  s = s.replace(/\s+(official|music|channel|tv)$/i, '');
  return tidy(s);
}

export function parseVideoTitle(rawTitle: string, channel?: string): TitleGuess[] {
  const base = tidy(stripNoiseBrackets(normalizeTitle(rawTitle)));
  const channelArtist = channel ? cleanChannelName(channel) : '';
  const out: TitleGuess[] = [];

  const push = (artistRaw: string, trackRaw: string, confidence: number) => {
    const artist = cleanFragment(artistRaw);
    const track = cleanFragment(trackRaw);
    if (!track) return;
    if (out.some((g) => g.artist === artist && g.track === track)) return;
    out.push({ artist, track, confidence });

    // "IU(아이유)" / "BTS (방탄소년단)" — alt-script name in brackets. Add
    // variants with the plain and bracketed forms so provider search can hit
    // whichever script the database indexes.
    const alt = /^(.*?)\s*\(([^)]+)\)$/.exec(artist);
    if (alt && alt[1]!.trim()) {
      push(alt[1]!, trackRaw, confidence - 0.05);
      push(alt[2]!, trackRaw, confidence - 0.1);
    }
  };

  // 1) Quoted track: Artist「Title」/ Artist 'Title' …
  for (const re of QUOTE_RES) {
    const m = re.exec(base);
    if (m) {
      const remainder = base.slice(0, m.index) + ' ' + base.slice(m.index + m[0].length);
      push(remainder, m[1]!, cleanFragment(remainder) ? 0.8 : 0.5);
      break;
    }
  }

  // 2) Separator split (first occurrence), plus the swapped order.
  for (const sep of SEPARATORS) {
    const i = base.indexOf(sep);
    if (i > 0 && i + sep.length < base.length) {
      const a = base.slice(0, i);
      const b = base.slice(i + sep.length);
      let confA = 0.6;
      let confB = 0.4;
      if (channelArtist) {
        const simA = diceSimilarity(channelArtist, cleanFragment(a));
        const simB = diceSimilarity(channelArtist, cleanFragment(b));
        if (simA >= 0.6 && simA > simB) confA = 0.85;
        else if (simB >= 0.6 && simB > simA) confB = 0.85;
      }
      push(a, b, confA);
      push(b, a, confB);
      break;
    }
  }

  // 3) Fallbacks: channel as artist, then raw title only.
  const whole = cleanTitleForSearch(rawTitle);
  if (channelArtist) push(channelArtist, whole, 0.35);
  push('', whole, 0.2);

  return out.sort((x, y) => y.confidence - x.confidence).slice(0, 6);
}
