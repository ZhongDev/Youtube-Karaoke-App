import { stripLrcTags } from './language';

/**
 * Reference text for the alignment worker (SPEC.md §5 Tier 3): one sung line
 * per row. LRC timestamps / word tags / metadata and bracketed section
 * headers like "[Chorus]" are removed, whitespace collapsed, blanks dropped —
 * every remaining line becomes exactly one word-timed LRC line.
 */
export function referenceText(body: string): string {
  return stripLrcTags(body)
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
