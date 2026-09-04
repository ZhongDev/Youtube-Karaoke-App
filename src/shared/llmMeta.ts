// Pure half of the optional Ollama title-parsing assist (SPEC.md §6 step 4):
// prompt construction and strict validation of the model's JSON reply. The
// network call lives in main/ollama.ts. Anything short of a well-formed
// {artist, track, confidence} object is rejected — heuristics then win.

import type { TitleGuess } from './titleParser';

export const LLM_SYSTEM_PROMPT =
  'You extract song metadata from YouTube video titles. ' +
  'Reply with ONLY a JSON object of the form ' +
  '{"artist": string, "track": string, "confidence": number} where confidence is 0..1. ' +
  'Keep names exactly as written in the title, in their original script; do not translate ' +
  'or romanize. Drop decorations like "Official MV", "(Lyric Video)", "M/V", "【MV】" and ' +
  'featuring clauses from the track name. Use an empty string when a field is unknown.';

export function buildLlmPrompt(title: string, channel: string): string {
  return `YouTube title: ${JSON.stringify(title)}\nChannel: ${JSON.stringify(channel)}`;
}

/**
 * Parse the model's reply. Tolerates surrounding prose / code fences by
 * extracting the first {...} block, but the object itself must be strict.
 */
export function parseLlmMetaReply(text: string): TitleGuess | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const artist = typeof o['artist'] === 'string' ? o['artist'].trim() : '';
  const track = typeof o['track'] === 'string' ? o['track'].trim() : '';
  const confRaw = o['confidence'];
  const confidence =
    typeof confRaw === 'number' && Number.isFinite(confRaw)
      ? Math.min(1, Math.max(0, confRaw))
      : NaN;
  if (!track || Number.isNaN(confidence)) return null;
  return { artist, track, confidence };
}
