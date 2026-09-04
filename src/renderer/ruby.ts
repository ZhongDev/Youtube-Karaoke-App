import type { RubyMode } from '../shared/ipc';

// Reading-aid segmentation for the two-track display. A line is drawn as a
// sequence of segments; a segment with `ruby` gets that text centred above
// its base characters. Extraction (kuroshiro/kuromoji furigana, romaji) is
// Phase 6 work — until then every line is a single unannotated segment, so
// the display code is already wired for it.

export interface RubySegment {
  base: string;
  ruby?: string;
}

export function annotate(text: string, mode: RubyMode): RubySegment[] {
  void mode; // no extractor yet
  return [{ base: text }];
}
