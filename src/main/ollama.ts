import { net } from 'electron';
import type { OllamaSettings } from '../shared/ipc';
import { buildLlmPrompt, LLM_SYSTEM_PROMPT, parseLlmMetaReply } from '../shared/llmMeta';
import type { TitleGuess } from '../shared/titleParser';

// Optional local-LLM title parsing (SPEC.md §6 step 4). Off by default;
// only consulted when the heuristic parser is unsure. Never required and
// never throws — any error/timeout yields null and the heuristics stand.

const TIMEOUT_MS = 15_000;

interface GenerateReply {
  response?: string;
  error?: string;
}

async function generate(
  settings: OllamaSettings,
  body: Record<string, unknown>,
): Promise<Response> {
  return net.fetch(`${settings.endpoint.replace(/\/+$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function askOllamaForMeta(
  settings: OllamaSettings,
  title: string,
  channel: string,
): Promise<TitleGuess | null> {
  const body: Record<string, unknown> = {
    model: settings.model,
    system: LLM_SYSTEM_PROMPT,
    prompt: buildLlmPrompt(title, channel),
    stream: false,
    format: 'json',
    options: { temperature: 0, num_predict: 200 },
  };
  const started = Date.now();
  try {
    // Thinking models would burn the whole timeout reasoning; ask them not
    // to. Older servers / non-thinking models may reject the flag → retry.
    let res = await generate(settings, { ...body, think: false });
    if (res.status === 400) res = await generate(settings, body);
    if (!res.ok) {
      console.warn(`[ollama] ${res.status} from ${settings.endpoint} (model ${settings.model})`);
      return null;
    }
    const json = (await res.json()) as GenerateReply;
    if (json.error) {
      console.warn(`[ollama] error: ${json.error}`);
      return null;
    }
    const guess = parseLlmMetaReply(json.response ?? '');
    console.log(
      `[ollama] ${Date.now() - started}ms → ${
        guess ? `[${guess.artist} / ${guess.track}] @${guess.confidence}` : 'unusable reply'
      }`,
    );
    return guess;
  } catch (err) {
    console.warn(`[ollama] unreachable/timeout (${settings.endpoint}):`, err);
    return null;
  }
}
