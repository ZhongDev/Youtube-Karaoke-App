import { describe, expect, it } from 'vitest';
import type { SearchResult } from './ipc';
import {
  classifyInput,
  isTopicEntry,
  parseSearchJson,
  pickTopicUpload,
  topicSearchQueries,
} from './ytSearch';

// Entries trimmed from real `yt-dlp "ytsearch10:…" -J --flat-playlist` output
// (2026-09). Note how Topic uploads are attributed to the artist's official
// channel and only their description gives them away.
const FIXTURE = JSON.stringify({
  _type: 'playlist',
  entries: [
    {
      _type: 'url',
      id: 'dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      channel: 'Rick Astley',
      uploader: 'Rick Astley',
      duration: 214,
      view_count: 1_600_000_000,
      description: 'The official video for “Never Gonna Give You Up” by Rick Astley.',
      live_status: null,
    },
    {
      id: '-aIiQj79b6Q',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      duration: 214,
      description: 'Provided to YouTube by Universal Music Group Never Gonna Give You Up · Rick Astley',
    },
    {
      id: '0k7BvzQRrOI',
      title: 'Never Gonna Give You Up (Instrumental)',
      channel: 'Rick Astley',
      duration: 379,
      description: 'Provided to YouTube by BMG Rights Management (UK) Ltd.',
    },
    { id: 'ZQx1ulFnhAk', title: 'ヨアソビ', channel: 'yoasobi - Topic', duration: 218 },
    { id: 'zL19uMsnpSU', title: '12 hour loop', uploader: 'cameron barnett', duration: null },
    { id: 'liveXXXXXXX', title: 'Live now', channel: 'Someone', live_status: 'is_live' },
    { id: 'bad', title: 'malformed id' },
    'not an object',
    {
      id: 'I0_ZXHzKysc',
      title: 'Blueming (Blueming)',
      channel: '이지금 [IU Official]',
      duration: 218,
      description: 'Provided to YouTube by Kakao Entertainment Blueming · IU',
    },
    {
      id: 'Jj5ZIjZ4nx0',
      title: 'Blueming',
      channel: 'Release - Topic',
      duration: 187,
      description: 'Provided to YouTube by DistroKid Blueming · Release',
    },
  ],
});

const results = parseSearchJson(FIXTURE);
const byId = (id: string): SearchResult => {
  const r = results.find((x) => x.videoId === id);
  if (!r) throw new Error(`fixture missing ${id}`);
  return r;
};

describe('parseSearchJson', () => {
  it('keeps well-formed video entries and drops live/malformed ones', () => {
    expect(results.map((r) => r.videoId)).toEqual([
      'dQw4w9WgXcQ',
      '-aIiQj79b6Q',
      '0k7BvzQRrOI',
      'ZQx1ulFnhAk',
      'zL19uMsnpSU',
      'I0_ZXHzKysc',
      'Jj5ZIjZ4nx0',
    ]);
  });

  it('maps fields, falling back to uploader and null duration', () => {
    expect(byId('dQw4w9WgXcQ')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      channel: 'Rick Astley',
      durationS: 214,
      isTopic: false,
      viewCount: 1_600_000_000,
      embeddable: true,
    });
    expect(byId('zL19uMsnpSU')).toMatchObject({ channel: 'cameron barnett', durationS: null });
  });

  it('detects Topic uploads by channel suffix or "Provided to YouTube by"', () => {
    expect(byId('-aIiQj79b6Q').isTopic).toBe(true);
    expect(byId('ZQx1ulFnhAk').isTopic).toBe(true);
    expect(byId('I0_ZXHzKysc').isTopic).toBe(true);
    expect(byId('dQw4w9WgXcQ').isTopic).toBe(false);
    expect(isTopicEntry('YOASOBI - Topic', '')).toBe(true);
    expect(isTopicEntry('YOASOBI', '  Provided to YouTube by The Orchard')).toBe(true);
    expect(isTopicEntry('Topical News', 'Provided by nobody')).toBe(false);
  });

  it('tolerates a document without entries', () => {
    expect(parseSearchJson('{"_type":"playlist"}')).toEqual([]);
  });
});

describe('classifyInput', () => {
  it('routes URLs and ids straight to the queue', () => {
    expect(classifyInput('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      kind: 'videos',
      ids: ['dQw4w9WgXcQ'],
    });
    expect(
      classifyInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ  https://youtu.be/-aIiQj79b6Q'),
    ).toEqual({ kind: 'videos', ids: ['dQw4w9WgXcQ', '-aIiQj79b6Q'] });
    expect(classifyInput(' dQw4w9WgXcQ ')).toEqual({ kind: 'videos', ids: ['dQw4w9WgXcQ'] });
  });

  it('treats plain words as a query, even 11-letter ones', () => {
    expect(classifyInput('aimyon marigold')).toEqual({ kind: 'query', query: 'aimyon marigold' });
    expect(classifyInput('Complicated')).toEqual({ kind: 'query', query: 'Complicated' });
    expect(classifyInput('UNSTOPPABLE')).toEqual({ kind: 'query', query: 'UNSTOPPABLE' });
    expect(classifyInput('https://youtu.be/dQw4w9WgXcQ live')).toEqual({
      kind: 'query',
      query: 'https://youtu.be/dQw4w9WgXcQ live',
    });
    expect(classifyInput('   ')).toEqual({ kind: 'empty' });
  });
});

describe('pickTopicUpload', () => {
  const rick = {
    artist: 'Rick Astley',
    track: 'Never Gonna Give You Up',
    excludeIds: ['dQw4w9WgXcQ'],
  };

  it('prefers the studio upload over the instrumental and the excluded video', () => {
    const pick = pickTopicUpload(results, { ...rick, targetDurationS: 213 });
    expect(pick?.result.videoId).toBe('-aIiQj79b6Q');
    expect(pickTopicUpload(results, { ...rick, targetDurationS: null })?.result.videoId).toBe(
      '-aIiQj79b6Q',
    );
  });

  it('never picks a non-Topic or embed-blocked upload', () => {
    const blocked = results.map((r) =>
      r.videoId === '-aIiQj79b6Q' ? { ...r, embeddable: false } : r,
    );
    expect(pickTopicUpload(blocked, { ...rick, targetDurationS: 214 })).toBeNull();
    const only = [byId('dQw4w9WgXcQ')];
    expect(pickTopicUpload(only, { ...rick, excludeIds: [], targetDurationS: null })).toBeNull();
  });

  it('matches bracketed alt-script titles and artist-in-channel names', () => {
    const want = { artist: 'IU(아이유)', track: 'Blueming(블루밍)', excludeIds: ['D1PvIWdJ8xo'] };
    // The alt-script artist form still relates to the official channel → full score.
    expect(pickTopicUpload(results, { ...want, targetDurationS: 218 })?.score).toBeGreaterThan(
      0.9,
    );
    expect(pickTopicUpload(results, { ...want, targetDurationS: 218 })?.result.videoId).toBe(
      'I0_ZXHzKysc',
    );
    // Without a target duration the wrong artist's exact-title upload must still lose.
    expect(pickTopicUpload(results, { ...want, targetDurationS: null })?.result.videoId).toBe(
      'I0_ZXHzKysc',
    );
    const wrongArtistOnly = [byId('Jj5ZIjZ4nx0')];
    expect(pickTopicUpload(wrongArtistOnly, { ...want, targetDurationS: null })).toBeNull();
  });

  it('rejects uploads whose length disagrees with the lyrics recording', () => {
    const want = { artist: 'IU', track: 'Blueming', excludeIds: [] };
    // 218 s is 18 s off and 187 s is 13 s off → neither is the recording.
    expect(pickTopicUpload(results, { ...want, targetDurationS: 200 })).toBeNull();
    // An exact title at exactly the recording's length outweighs a channel
    // name that cannot be related to the artist (romaji vs kana names, …).
    expect(pickTopicUpload(results, { ...want, targetDurationS: 187 })?.result.videoId).toBe(
      'Jj5ZIjZ4nx0',
    );
  });
});

describe('topicSearchQueries', () => {
  it('quotes the auto-generated description phrase first, then the Topic channel', () => {
    expect(topicSearchQueries('YOASOBI', '夜に駆ける')).toEqual([
      'YOASOBI 夜に駆ける "Provided to YouTube by"',
      '"YOASOBI - Topic" 夜に駆ける',
    ]);
    expect(topicSearchQueries('', 'Marigold')).toEqual(['Marigold "Provided to YouTube by"']);
    expect(topicSearchQueries('Aimyon', '')).toEqual([]);
  });
});
