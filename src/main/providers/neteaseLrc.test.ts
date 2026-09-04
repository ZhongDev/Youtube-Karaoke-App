import { describe, expect, it } from 'vitest';
import { cleanNeteaseLrc, countTimedTextLines } from './neteaseLrc';

const REAL_HEAD =
  '[00:00.000] 制作人 : Ayase\n[00:00.357] 作词 : Ayase\n[00:00.714] 作曲 : Ayase\n' +
  '[00:01.071] 编曲 : Ayase\n[00:01.430]沈むように溶けてゆくように\n[00:08.831]二人だけの空が広がる夜に\n' +
  '[00:21.295]\n[00:31.481]「さよなら」だけだった';

describe('cleanNeteaseLrc', () => {
  it('drops credit lines but keeps timed lyric lines and blank spacers', () => {
    const out = cleanNeteaseLrc(REAL_HEAD)!;
    expect(out).not.toMatch(/作词|作曲|编曲|制作人/);
    expect(out.split('\n')).toEqual([
      '[00:01.430]沈むように溶けてゆくように',
      '[00:08.831]二人だけの空が広がる夜に',
      '[00:21.295]',
      '[00:31.481]「さよなら」だけだった',
    ]);
  });

  it('handles Korean-style credits with slashes and English credit labels', () => {
    const out = cleanNeteaseLrc(
      '[00:00.00] 作词 : IU\n[00:01.00] 作曲 : IU/이종훈/이채규\n[00:02.00] Produced by : X\n[00:09.06]“뭐해?” 라는 두 글자에',
    );
    expect(out).toBe('[00:09.06]“뭐해?” 라는 두 글자에');
  });

  it('returns null for empty, credits-only and instrumental bodies', () => {
    expect(cleanNeteaseLrc('')).toBeNull();
    expect(cleanNeteaseLrc(null)).toBeNull();
    expect(cleanNeteaseLrc('[00:00.00] 作词 : A\n[00:01.00] 作曲 : B')).toBeNull();
    expect(cleanNeteaseLrc('[99:00.00]纯音乐，请欣赏')).toBeNull();
    expect(cleanNeteaseLrc('[00:00.00] 纯音乐，请欣赏')).toBeNull();
  });

  it('does not treat a lyric line containing a colon as a credit', () => {
    const out = cleanNeteaseLrc('[00:05.00]Baby: come back\n[00:07.00]Now');
    expect(out).toBe('[00:05.00]Baby: come back\n[00:07.00]Now');
  });
});

describe('countTimedTextLines', () => {
  it('ignores blank timed lines and metadata tags', () => {
    expect(countTimedTextLines('[ar:x]\n[00:01.00]a\n[00:02.00]\n[00:03.00]b')).toBe(2);
  });
});
