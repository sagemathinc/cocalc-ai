/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Small typo-tolerant word matching, used by Quick Navigation. Pure string
// functions; callers fold case/accents themselves.

// Restricted Damerau-Levenshtein (optimal string alignment): insertions,
// deletions, substitutions and transpositions of adjacent characters each
// cost 1.
export function damerauLevenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
}

// How many typos a search term may contain: one, or two for long terms.
export function typoLimit(term: string): number {
  return term.length >= 8 ? 2 : 1;
}

export interface FuzzyWordMatch {
  // Offset of the matched word in the text, and the matched length (the whole
  // word, or a prefix of it).
  index: number;
  length: number;
  // Number of edits between the term and the matched text.
  cost: number;
}

export const FUZZY_MIN_TERM_LENGTH = 3;
export const FUZZY_MAX_TERM_LENGTH = 64;

// Find the word in `text` that best matches `term` within its typo limit.
// The first letter must agree, so short terms do not match everything, and
// words are compared both whole and by prefix, so a typo early in a long word
// still matches ("chatper" finds "chapter2", "specct" finds "spectral").
// Returns the cheapest match, earliest on ties, or undefined.
export function fuzzyFindWord(
  term: string,
  text: string,
): FuzzyWordMatch | undefined {
  if (
    term.length < FUZZY_MIN_TERM_LENGTH ||
    term.length > FUZZY_MAX_TERM_LENGTH
  )
    return undefined;
  const limit = typoLimit(term);
  let best: FuzzyWordMatch | undefined;
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const value = word[0];
    if (value[0] !== term[0]) continue;
    const lengths = new Set<number>([value.length]);
    for (let n = term.length - limit; n <= term.length + limit; n++)
      if (n >= 1 && n <= value.length) lengths.add(n);
    for (const length of lengths) {
      if (Math.abs(length - term.length) > limit) continue;
      const cost = damerauLevenshtein(term, value.slice(0, length));
      if (cost <= limit && (!best || cost < best.cost))
        best = { index: word.index!, length, cost };
    }
  }
  return best;
}
