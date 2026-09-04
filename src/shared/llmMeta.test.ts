import { describe, expect, it } from 'vitest';
import { buildLlmPrompt, parseLlmMetaReply } from './llmMeta';

describe('parseLlmMetaReply', () => {
  it('accepts a strict JSON object', () => {
    expect(parseLlmMetaReply('{"artist":"IU","track":"Blueming","confidence":0.9}')).toEqual({
      artist: 'IU',
      track: 'Blueming',
      confidence: 0.9,
    });
  });

  it('tolerates fences / prose around the object and clamps confidence', () => {
    const r = parseLlmMetaReply(
      'Sure!\n```json\n{"artist": "YOASOBI", "track": "夜に駆ける", "confidence": 1.7}\n```',
    );
    expect(r).toEqual({ artist: 'YOASOBI', track: '夜に駆ける', confidence: 1 });
  });

  it('allows an unknown artist but requires a track and numeric confidence', () => {
    expect(parseLlmMetaReply('{"artist":"","track":"Song","confidence":0.4}')).toEqual({
      artist: '',
      track: 'Song',
      confidence: 0.4,
    });
    expect(parseLlmMetaReply('{"artist":"X","track":"","confidence":0.9}')).toBeNull();
    expect(parseLlmMetaReply('{"artist":"X","track":"Y","confidence":"high"}')).toBeNull();
    expect(parseLlmMetaReply('{"artist":"X","track":"Y"}')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(parseLlmMetaReply('')).toBeNull();
    expect(parseLlmMetaReply('not json')).toBeNull();
    expect(parseLlmMetaReply('{"artist": "X", "track": }')).toBeNull();
    expect(parseLlmMetaReply('[1,2]')).toBeNull();
  });
});

describe('buildLlmPrompt', () => {
  it('quotes the title and channel so embedded quotes cannot break the prompt', () => {
    const p = buildLlmPrompt('Artist "Song" MV', 'Ch');
    expect(p).toContain('"Artist \\"Song\\" MV"');
    expect(p).toContain('Channel: "Ch"');
  });
});
