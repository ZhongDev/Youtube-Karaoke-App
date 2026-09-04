import { describe, expect, it } from 'vitest';
import {
  bestSimilarity,
  cleanChannelName,
  cleanTitleForSearch,
  parseVideoTitle,
  titleVariants,
} from './titleParser';

/** Assert the expected pair appears in the top N candidates. */
function expectGuess(
  title: string,
  channel: string | undefined,
  artist: string,
  track: string,
  topN = 2,
) {
  const guesses = parseVideoTitle(title, channel);
  const hit = guesses
    .slice(0, topN)
    .some((g) => g.artist === artist && g.track === track);
  expect(
    hit,
    `expected [${artist} / ${track}] in top ${topN} of ${JSON.stringify(guesses)}`,
  ).toBe(true);
}

describe('parseVideoTitle — English', () => {
  it('Artist - Title (Official Music Video)', () => {
    expectGuess(
      'Rick Astley - Never Gonna Give You Up (Official Music Video)',
      'Rick Astley',
      'Rick Astley',
      'Never Gonna Give You Up',
      1,
    );
  });

  it('en dash separator + remaster noise', () => {
    expectGuess(
      'Queen – Bohemian Rhapsody (Official Video Remastered)',
      'Queen Official',
      'Queen',
      'Bohemian Rhapsody',
      1,
    );
  });

  it('artist containing a hyphen (a-ha) is not split', () => {
    expectGuess(
      'a-ha - Take On Me (Official Video) [4K]',
      'a-ha',
      'a-ha',
      'Take On Me',
      1,
    );
  });

  it('lyric video noise', () => {
    expectGuess('Adele - Hello (Lyric Video)', undefined, 'Adele', 'Hello', 1);
  });

  it('live parenthetical stripped for search', () => {
    expectGuess(
      'Eagles - Hotel California (Live 1977) (Official Video) [HD]',
      undefined,
      'Eagles',
      'Hotel California',
      1,
    );
  });

  it('Title - Artist order appears as the swap candidate, feat stripped', () => {
    const guesses = parseVideoTitle(
      'Somebody That I Used to Know - Gotye (feat. Kimbra)',
    );
    expect(
      guesses.some(
        (g) => g.artist === 'Gotye' && g.track === 'Somebody That I Used to Know',
      ),
    ).toBe(true);
  });

  it('multiple artists before separator', () => {
    expectGuess(
      'Lady Gaga, Bruno Mars - Die With A Smile (Official Music Video)',
      undefined,
      'Lady Gaga, Bruno Mars',
      'Die With A Smile',
      1,
    );
  });

  it('channel boosts the artist-side of an ambiguous split (VEVO)', () => {
    const guesses = parseVideoTitle(
      'Never Gonna Give You Up - Rick Astley',
      'RickAstleyVEVO',
    );
    expect(guesses[0]).toMatchObject({
      artist: 'Rick Astley',
      track: 'Never Gonna Give You Up',
    });
  });
});

describe('parseVideoTitle — Japanese', () => {
  it('Artist MV「Title」', () => {
    expectGuess('米津玄師 MV「Lemon」', undefined, '米津玄師', 'Lemon', 1);
  });

  it('Artist「Title」 Official Music Video', () => {
    expectGuess(
      'YOASOBI「夜に駆ける」 Official Music Video',
      'Ayase / YOASOBI',
      'YOASOBI',
      '夜に駆ける',
      1,
    );
  });

  it('【MV】Artist - Title (OFFICIAL VIDEO)', () => {
    expectGuess(
      '【MV】ヨルシカ - だから僕は音楽を辞めた (OFFICIAL VIDEO)',
      undefined,
      'ヨルシカ',
      'だから僕は音楽を辞めた',
      1,
    );
  });

  it('artist named "Official髭男dism" survives noise stripping', () => {
    expectGuess(
      'Official髭男dism - Pretender［Official Video］',
      undefined,
      'Official髭男dism',
      'Pretender',
      1,
    );
  });

  it('plain Artist - Title with no noise', () => {
    expectGuess('King Gnu - 白日', undefined, 'King Gnu', '白日', 1);
  });

  it('『Title』 with trailing anime tie-in parenthetical', () => {
    expectGuess(
      'Aimer 『残響散歌』MUSIC VIDEO(TVアニメ「鬼滅の刃」遊郭編オープニングテーマ)',
      undefined,
      'Aimer',
      '残響散歌',
      1,
    );
  });

  it('宇多田ヒカル 『First Love』', () => {
    expectGuess('宇多田ヒカル 『First Love』', undefined, '宇多田ヒカル', 'First Love', 1);
  });
});

describe('parseVideoTitle — Korean', () => {
  it("BTS (방탄소년단) '봄날 (Spring Day)' Official MV", () => {
    expectGuess(
      "BTS (방탄소년단) '봄날 (Spring Day)' MV",
      'HYBE LABELS',
      'BTS (방탄소년단)',
      '봄날 (Spring Day)',
      1,
    );
  });

  it('paren alt-name generates plain-name variants', () => {
    const guesses = parseVideoTitle("BTS (방탄소년단) '봄날 (Spring Day)' MV");
    expect(guesses.some((g) => g.artist === 'BTS')).toBe(true);
    expect(guesses.some((g) => g.artist === '방탄소년단')).toBe(true);
  });

  it("BLACKPINK - 'Title' M/V", () => {
    expectGuess(
      "BLACKPINK - '뚜두뚜두 (DDU-DU DDU-DU)' M/V",
      'BLACKPINK',
      'BLACKPINK',
      '뚜두뚜두 (DDU-DU DDU-DU)',
      1,
    );
  });

  it('1theK style: [MV] Artist _ Title', () => {
    expectGuess(
      '[MV] IU(아이유) _ Blueming(블루밍)',
      '1theK (원더케이)',
      'IU(아이유)',
      'Blueming(블루밍)',
      1,
    );
  });

  it("aespa 에스파 'Next Level' MV", () => {
    expectGuess(
      "aespa 에스파 'Next Level' MV",
      'SMTOWN',
      'aespa 에스파',
      'Next Level',
      1,
    );
  });
});

describe('parseVideoTitle — fallbacks', () => {
  it('no separator: channel becomes the artist candidate', () => {
    const guesses = parseVideoTitle('Never Gonna Give You Up', 'Rick Astley - Topic');
    expect(guesses[0]).toMatchObject({
      artist: 'Rick Astley',
      track: 'Never Gonna Give You Up',
    });
  });

  it('always includes a bare-title candidate for q= search', () => {
    const guesses = parseVideoTitle('some obscure upload #shorts');
    expect(guesses.some((g) => g.artist === '' && g.track === 'some obscure upload')).toBe(
      true,
    );
  });
});

describe('cleanTitleForSearch / cleanChannelName', () => {
  it('strips decorations but keeps the meat', () => {
    expect(
      cleanTitleForSearch('IVE 아이브 \'After LIKE\' MV (Performance Ver.)'),
    ).toBe("IVE 아이브 'After LIKE'");
  });

  it('channel cleaning', () => {
    expect(cleanChannelName('Rick Astley - Topic')).toBe('Rick Astley');
    expect(cleanChannelName('QueenOfficial')).toBe('QueenOfficial');
    expect(cleanChannelName('TaylorSwiftVEVO')).toBe('TaylorSwift');
  });
});

describe('titleVariants', () => {
  it('splits a bracketed alt-script name into full / main / alt', () => {
    expect(titleVariants('Blueming(블루밍)')).toEqual(['Blueming(블루밍)', 'Blueming', '블루밍']);
    expect(titleVariants('봄날 (Spring Day)')).toEqual(['봄날 (Spring Day)', '봄날', 'Spring Day']);
    expect(titleVariants('IU(아이유)')).toEqual(['IU(아이유)', 'IU', '아이유']);
    expect(titleVariants('夜に駆ける（Racing into the Night）')).toEqual([
      '夜に駆ける（Racing into the Night）',
      '夜に駆ける',
      'Racing into the Night',
    ]);
  });

  it('returns just the name when there is nothing to split', () => {
    expect(titleVariants('Pretender')).toEqual(['Pretender']);
    expect(titleVariants('(Not) A Devil')).toEqual(['(Not) A Devil']);
    expect(titleVariants('')).toEqual([]);
    expect(titleVariants('  ')).toEqual([]);
  });
});

describe('bestSimilarity', () => {
  it('takes the best variant', () => {
    const v = titleVariants('Blueming(블루밍)');
    expect(bestSimilarity(v, 'Blueming')).toBe(1);
    expect(bestSimilarity(v, '블루밍')).toBe(1);
    expect(bestSimilarity([], 'x')).toBe(0);
  });
});
