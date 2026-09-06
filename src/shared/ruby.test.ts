import { describe, expect, it } from 'vitest';
import {
  kanaToRomaji,
  kataToHira,
  readingLine,
  romajiOf,
  romanizeHangul,
  segmentsJa,
  segmentsKo,
  splitOkurigana,
  type JaToken,
} from './ruby';

const T = (surface: string, reading: string | null, pos = '名詞'): JaToken => ({
  surface,
  reading,
  pos,
});

describe('kataToHira', () => {
  it('maps katakana only, keeps ー and everything else', () => {
    expect(kataToHira('トウキョウ')).toBe('とうきょう');
    expect(kataToHira('ラーメン abc 漢')).toBe('らーめん abc 漢');
    expect(kataToHira('ヴ')).toBe('ゔ');
  });
});

describe('kanaToRomaji', () => {
  it('handles the basic table and digraphs', () => {
    expect(kanaToRomaji('よるにかける')).toBe('yorunikakeru');
    expect(kanaToRomaji('とうきょう')).toBe('toukyou');
    expect(kanaToRomaji('しゃしん')).toBe('shashin');
    expect(kanaToRomaji('ちゅう')).toBe('chuu');
    expect(kanaToRomaji('ふじさん')).toBe('fujisan');
    expect(kanaToRomaji('つづく')).toBe('tsuzuku');
  });

  it('doubles consonants after っ, including tch', () => {
    expect(kanaToRomaji('きっと')).toBe('kitto');
    expect(kanaToRomaji('まっちゃ')).toBe('matcha');
    expect(kanaToRomaji('がっこう')).toBe('gakkou');
    expect(kanaToRomaji('あっ')).toBe('a');
  });

  it("marks ん before vowels and y with an apostrophe", () => {
    expect(kanaToRomaji('しんや')).toBe("shin'ya");
    expect(kanaToRomaji('きんえん')).toBe("kin'en");
    expect(kanaToRomaji('せんせい')).toBe('sensei');
    expect(kanaToRomaji('ほん')).toBe('hon');
  });

  it('handles katakana input, long-vowel marks and loanword combos', () => {
    expect(kanaToRomaji('ラーメン')).toBe('raamen');
    expect(kanaToRomaji('パーティー')).toBe('paatii');
    expect(kanaToRomaji('ファン')).toBe('fan');
    expect(kanaToRomaji('ヴァイオリン')).toBe('vaiorin');
  });

  it('passes non-kana through', () => {
    expect(kanaToRomaji('abc、123')).toBe('abc、123');
  });
});

describe('splitOkurigana', () => {
  it('leaves kana prefix/suffix outside the ruby', () => {
    expect(splitOkurigana('食べる', 'たべる')).toEqual([{ base: '食', ruby: 'た' }, { base: 'べる' }]);
    expect(splitOkurigana('走り出す', 'はしりだす')).toEqual([
      { base: '走り出', ruby: 'はしりだ' },
      { base: 'す' },
    ]);
    expect(splitOkurigana('お母さん', 'おかあさん')).toEqual([
      { base: 'お' },
      { base: '母', ruby: 'かあ' },
      { base: 'さん' },
    ]);
  });

  it('annotates whole-kanji tokens and skips kana-only ones', () => {
    expect(splitOkurigana('東京', 'とうきょう')).toEqual([{ base: '東京', ruby: 'とうきょう' }]);
    expect(splitOkurigana('きっと', 'きっと')).toEqual([{ base: 'きっと' }]);
  });
});

describe('romajiOf', () => {
  it('reads particles は / へ as wa / e', () => {
    expect(romajiOf(T('は', 'ハ', '助詞'))).toBe('wa');
    expect(romajiOf(T('へ', 'ヘ', '助詞'))).toBe('e');
    expect(romajiOf(T('は', 'ハ', '名詞'))).toBe('ha');
    expect(romajiOf(T('を', 'ヲ', '助詞'))).toBe('o');
  });

  it('falls back to a kana surface when the dictionary has no reading', () => {
    expect(romajiOf(T('ぼっち', null))).toBe('botchi');
    expect(romajiOf(T('Hello', null))).toBeNull();
  });
});

describe('segmentsJa', () => {
  const tokens: JaToken[] = [
    T('私', 'ワタシ'),
    T('は', 'ハ', '助詞'),
    T('東京', 'トウキョウ'),
    T('へ', 'ヘ', '助詞'),
    T('行き', 'イキ', '動詞'),
    T('ます', 'マス', '助動詞'),
    T('。', '。', '記号'),
  ];

  it('furigana: ruby on kanji only, kana runs merged', () => {
    expect(segmentsJa(tokens, 'furigana')).toEqual([
      { base: '私', ruby: 'わたし' },
      { base: 'は' },
      { base: '東京', ruby: 'とうきょう' },
      { base: 'へ' },
      { base: '行', ruby: 'い' },
      { base: 'きます。' },
    ]);
  });

  it('romaji: every Japanese token annotated, particles corrected', () => {
    expect(segmentsJa(tokens, 'romaji')).toEqual([
      { base: '私', ruby: 'watashi' },
      { base: 'は', ruby: 'wa' },
      { base: '東京', ruby: 'toukyou' },
      { base: 'へ', ruby: 'e' },
      { base: '行き', ruby: 'iki' },
      { base: 'ます', ruby: 'masu' },
      { base: '。' },
    ]);
  });

  it('keeps Latin / spaces / unknown words as plain segments', () => {
    const mixed = [T('Hello', null), T(' ', null, '記号'), T('世界', 'セカイ'), T(' ', null, '記号'), T('wow', null)];
    expect(segmentsJa(mixed, 'romaji')).toEqual([
      { base: 'Hello ' },
      { base: '世界', ruby: 'sekai' },
      { base: ' wow' },
    ]);
    expect(segmentsJa([T('鬱', null)], 'furigana')).toEqual([{ base: '鬱' }]);
  });
});

describe('romanizeHangul', () => {
  it('follows the Revised Romanization tables', () => {
    expect(romanizeHangul('아이유')).toBe('aiyu');
    expect(romanizeHangul('사랑해요')).toBe('saranghaeyo');
    expect(romanizeHangul('안녕하세요')).toBe('annyeonghaseyo');
    expect(romanizeHangul('블루밍')).toBe('beulluming');
    expect(romanizeHangul('꽃')).toBe('kkot');
    expect(romanizeHangul('닭')).toBe('dak');
  });

  it('links a coda into a following vowel', () => {
    expect(romanizeHangul('한국어')).toBe('hangugeo');
    expect(romanizeHangul('없어')).toBe('eopseo');
    expect(romanizeHangul('좋아')).toBe('joa');
    expect(romanizeHangul('같이')).toBe('gachi');
    expect(romanizeHangul('강아지')).toBe('gangaji');
  });

  it('applies nasalisation, ㄹ assimilation and aspiration', () => {
    expect(romanizeHangul('국물')).toBe('gungmul');
    expect(romanizeHangul('입니다')).toBe('imnida');
    expect(romanizeHangul('설날')).toBe('seollal');
    expect(romanizeHangul('신라')).toBe('silla');
    expect(romanizeHangul('종로')).toBe('jongno');
    expect(romanizeHangul('백마')).toBe('baengma');
    expect(romanizeHangul('좋다')).toBe('jota');
    expect(romanizeHangul('축하')).toBe('chuka');
    expect(romanizeHangul('물론')).toBe('mullon');
  });

  it('passes other characters through', () => {
    expect(romanizeHangul('IU - 밤편지 (2017)')).toBe('IU - bampyeonji (2017)');
  });
});

describe('segmentsKo', () => {
  it('annotates each Hangul word and keeps the rest', () => {
    expect(segmentsKo('나의 IU 사랑')).toEqual([
      { base: '나의', ruby: 'naui' },
      { base: ' IU ' },
      { base: '사랑', ruby: 'sarang' },
    ]);
  });

  it('keeps punctuation out of the reading', () => {
    expect(segmentsKo('같아, ooh')).toEqual([
      { base: '같아', ruby: 'gata' },
      { base: ', ooh' },
    ]);
    expect(segmentsKo('(사랑해)')).toEqual([
      { base: '(' },
      { base: '사랑해', ruby: 'saranghae' },
      { base: ')' },
    ]);
  });
});

describe('readingLine', () => {
  it('joins readings, spaced or not', () => {
    const segs = [{ base: '私', ruby: 'watashi' }, { base: 'は', ruby: 'wa' }, { base: '。' }];
    expect(readingLine(segs, true)).toBe('watashi wa 。');
    expect(readingLine([{ base: '私', ruby: 'わたし' }, { base: 'は' }], false)).toBe('わたしは');
  });
});
