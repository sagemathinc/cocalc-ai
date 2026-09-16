/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fuzzyFindWord } from "@cocalc/util/fuzzy";
import type { Candidate } from "./model";

export type Span = [number, number];
export interface Match {
  item: Candidate;
  title: Span[];
  detail: Span[];
  tier: number;
  cost: number;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}
function normalize(text: string) {
  let value = "";
  const offsets: number[] = [];
  const boundaries = new Set<number>();
  let previous = "";
  let offset = 0;
  for (const char of text) {
    if (
      !previous ||
      !/[\p{L}\p{N}]/u.test(previous) ||
      (/[a-z]/.test(previous) && /[A-Z]/.test(char))
    )
      boundaries.add(value.length);
    const part = fold(char);
    for (let i = 0; i < part.length; i++) offsets.push(offset);
    value += part;
    offset += char.length;
    previous = char;
  }
  offsets.push(text.length);
  return { value, offsets, boundaries };
}

// Typo tolerance lives in @cocalc/util/fuzzy; here we only translate the
// matched word into highlight offsets of the original text.
function fuzzyMatch(text: ReturnType<typeof normalize>, term: string) {
  const found = fuzzyFindWord(term, text.value);
  if (!found) return undefined;
  return {
    tier: 3,
    cost: found.cost,
    span: [
      text.offsets[found.index],
      text.offsets[found.index + found.length],
    ] as Span,
  };
}

function matchTerm(
  text: ReturnType<typeof normalize>,
  term: string,
  fuzzy: boolean,
) {
  let best: { tier: number; cost: number; span: Span } | undefined;
  for (
    let at = text.value.indexOf(term);
    at >= 0;
    at = text.value.indexOf(term, at + 1)
  ) {
    const tier = text.boundaries.has(at) ? 1 : 2;
    if (!best || tier < best.tier)
      best = {
        tier,
        cost: at / 10000,
        span: [text.offsets[at], text.offsets[at + term.length]],
      };
  }
  if (best || !fuzzy) return best;
  return fuzzyMatch(text, term);
}

function collect(
  items: Candidate[],
  terms: string[],
  query: string,
  fuzzy: boolean,
): Match[] {
  const results: Match[] = [];
  for (const item of items) {
    const fields = [item.title, item.detail, item.keywords ?? ""].map(
      normalize,
    );
    const result: Match = { item, title: [], detail: [], tier: 0, cost: 0 };
    let matched = true;
    for (const term of terms) {
      const matches = fields
        .map((field, index) => ({
          match: matchTerm(field, term, fuzzy),
          index,
        }))
        .filter((x) => x.match != null)
        .sort(
          (a, b) =>
            a.match!.tier - b.match!.tier ||
            a.index - b.index ||
            a.match!.cost - b.match!.cost,
        );
      if (!matches.length) {
        matched = false;
        break;
      }
      const { match, index } = matches[0];
      result.tier = Math.max(result.tier, match!.tier);
      result.cost += match!.tier * 10 + index + match!.cost;
      // Highlight all displayed fields that matched, including project/path context.
      for (const entry of matches) {
        if (entry.index === 0) result.title.push(entry.match!.span);
        if (entry.index === 1) result.detail.push(entry.match!.span);
      }
    }
    if (matched) {
      if (terms.length && fields[0].value === query) {
        result.tier = 0;
        result.cost = 0;
      }
      results.push(result);
    }
  }
  return results.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.cost - b.cost ||
      a.item.priority - b.item.priority ||
      (b.item.recent ?? 0) - (a.item.recent ?? 0) ||
      a.item.title.localeCompare(b.item.title) ||
      a.item.id.localeCompare(b.item.id),
  );
}

// Exact, prefix and substring matches only; the typo-tolerant pass runs only
// when that finds nothing, so it never dilutes a search that has real hits.
export function searchCandidates(items: Candidate[], query: string): Match[] {
  const folded = fold(query.trim());
  const terms = folded.split(/\s+/).filter(Boolean);
  const strict = collect(items, terms, folded, false);
  if (strict.length || !terms.length) return strict;
  return collect(items, terms, folded, true);
}
