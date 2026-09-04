import { describe, expect, it } from 'vitest';
import { detectLanguage, detectTrackLanguage, stripLrcTags } from './language';

describe('detectLanguage', () => {
  it('flags kana as Japanese', () => {
    expect(detectLanguage('YOASOBI「夜に駆ける」 Official Music Video')).toBe('ja');
    expect(detectLanguage('あいみょん - マリーゴールド【OFFICIAL MUSIC VIDEO】')).toBe('ja');
    expect(detectLanguage('ヨルシカ')).toBe('ja'); // katakana only
  });

  it('flags Hangul as Korean', () => {
    expect(detectLanguage('[MV] IU(아이유) _ Blueming(블루밍)')).toBe('ko');
    expect(detectLanguage("BTS (방탄소년단) '봄날 (Spring Day)' Official MV")).toBe('ko');
  });

  it('prefers Korean when both scripts appear and Hangul dominates', () => {
    expect(detectLanguage('아이유 (IU) - 夜 ラ')).toBe('ko');
  });

  it('treats Latin-only text as English', () => {
    expect(detectLanguage('Rick Astley - Never Gonna Give You Up')).toBe('en');
    expect(detectLanguage('Café Déjà Vu')).toBe('en');
  });

  it('puts Han-only and empty text in other', () => {
    expect(detectLanguage('周杰倫 - 晴天')).toBe('other');
    expect(detectLanguage('')).toBe('other');
    expect(detectLanguage('123 ★★★')).toBe('other');
  });
});

describe('stripLrcTags', () => {
  it('removes time, word and metadata tags', () => {
    const s = stripLrcTags('[ar:X]\n[00:01.00]hello <00:02.00>world\n[00:03.00][00:04.00]again');
    expect(s.replace(/\s+/g, ' ').trim()).toBe('hello world again');
  });
});

describe('detectTrackLanguage', () => {
  it('lets the lyrics body override the title', () => {
    const body =
      '[00:01.00]Never gonna give you up\n[00:03.00]Never gonna let you down\n[00:05.00]never gonna run around';
    expect(detectTrackLanguage('デビルじゃないもん (English cover)', body)).toBe('en');
  });

  it('falls back to the title when the body is missing or too short', () => {
    expect(detectTrackLanguage('IU - Blueming(블루밍)', null)).toBe('ko');
    expect(detectTrackLanguage('IU - Blueming(블루밍)', '[00:01.00]la')).toBe('ko');
  });
});
