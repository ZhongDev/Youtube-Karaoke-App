import { describe, expect, it } from 'vitest';
import { referenceText } from './alignText';

describe('referenceText', () => {
  it('keeps plain lyrics line by line, dropping blank spacer lines', () => {
    expect(referenceText('Lie, bye Baby\n\nMy, my, my life\n')).toBe('Lie, bye Baby\nMy, my, my life');
  });

  it('strips LRC timestamps, word tags and metadata', () => {
    const lrc = '[ti:QUEEN]\n[00:01.00]<00:01.00>Lie, <00:01.30>bye <00:01.50>Baby\n[00:02.00][00:09.00]My life';
    expect(referenceText(lrc)).toBe('Lie, bye Baby\nMy life');
  });

  it('drops section headers and collapses whitespace; handles CRLF', () => {
    expect(referenceText('[Verse 1]\r\nHello   world \r\n[Chorus]\r\nla  la')).toBe(
      'Hello world\nla la',
    );
  });

  it('returns an empty string when nothing singable remains', () => {
    expect(referenceText('[00:01.00]\n[ar:x]\n   ')).toBe('');
  });
});
