import { useEffect, useState } from 'react';
import type { Language, LyricsDoc, RubyDoc, RubyMode } from '../shared/ipc';

// Reading aid for the playing document (Phase 6). Main computes it (kuromoji
// lives there) and caches it in the DB; this hook just asks once per
// (video, source, mode, body) and never shows a result against a different
// document than the one it was made for.

export function useRuby(
  videoId: string | null,
  doc: LyricsDoc | null,
  mode: RubyMode,
  language: Language | null,
): RubyDoc | null {
  const source = doc?.source ?? null;
  const wanted =
    videoId !== null &&
    doc !== null &&
    doc.kind !== 'plain' &&
    mode !== 'none' &&
    (language === 'ja' || language === 'ko');
  const key = wanted ? `${videoId}\n${source}\n${mode}\n${language}\n${doc.body}` : null;
  const [state, setState] = useState<{ key: string; doc: RubyDoc | null } | null>(null);

  useEffect(() => {
    if (!key || !videoId || !source) return;
    let alive = true;
    window.karaoke
      .rubyGet(videoId, source, mode)
      .then((d) => alive && setState({ key, doc: d }))
      .catch((err: unknown) => {
        console.warn('[ruby]', err);
        if (alive) setState({ key, doc: null });
      });
    return () => {
      alive = false;
    };
  }, [key, videoId, source, mode]);

  return key !== null && state?.key === key ? state.doc : null;
}
