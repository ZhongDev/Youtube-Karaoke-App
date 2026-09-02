// Tiny dependency-free string similarity for ranking provider results.

/** Lowercased NFKC with all whitespace/punctuation/symbols removed. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Sørensen–Dice bigram coefficient on normalized strings, 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na === nb) return na.length ? 1 : 0;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const n = bigrams.get(bg) ?? 0;
    if (n > 0) {
      hits++;
      bigrams.set(bg, n - 1);
    }
  }
  return (2 * hits) / (na.length - 1 + nb.length - 1);
}
