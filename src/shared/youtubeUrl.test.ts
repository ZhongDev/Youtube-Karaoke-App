import { describe, expect, it } from 'vitest';
import { extractVideoId } from './youtubeUrl';

describe('extractVideoId', () => {
  it('accepts the id forms', () => {
    expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('  dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
  });

  it('parses URL forms', () => {
    const id = 'dQw4w9WgXcQ';
    for (const u of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/watch?v=${id}&t=42s&list=PL123`,
      `https://youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}&si=abc`,
      `https://youtu.be/${id}`,
      `https://youtu.be/${id}?t=10`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}?feature=share`,
    ]) {
      expect(extractVideoId(u), u).toBe(id);
    }
  });

  it('rejects non-YouTube and malformed input', () => {
    expect(extractVideoId('https://vimeo.com/12345')).toBeNull();
    expect(extractVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(extractVideoId('not a url at all')).toBeNull();
    expect(extractVideoId('')).toBeNull();
  });
});
