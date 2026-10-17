/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The urlTransform contract (see FileContext):

- return a string to replace the URL,
- return undefined to leave it unchanged,
- return URL_REJECTED to reject it: the attribute is dropped.

Rejection is a distinct value, rather than undefined or null, so that the
common `transform(url) ?? url` pattern cannot silently turn a rejection back
into the original URL.  Consumers must use applyUrlTransform.
*/

export const URL_REJECTED: unique symbol = Symbol("url-rejected");

export type UrlTransformResult = string | undefined | typeof URL_REJECTED;

export type UrlTransform = (url: string, tag?: string) => UrlTransformResult;

// Returns the URL to use, or null if urlTransform rejected it.  A transform
// that throws rejects the URL.
export function applyUrlTransform(
  urlTransform: UrlTransform | undefined,
  url: string,
  tag?: string,
): string | null {
  if (urlTransform == null) {
    return url;
  }
  let result: UrlTransformResult;
  try {
    result = urlTransform(url, tag);
  } catch {
    return null;
  }
  if (result === URL_REJECTED) {
    return null;
  }
  return result ?? url;
}

export interface SrcsetCandidate {
  url: string;
  descriptors: string;
}

const DESCRIPTORS = /^(?:\s*\d+(?:\.\d+)?[wxh])*\s*$/i;

/*
Parse a srcset the way browsers do (HTML "parse a srcset attribute"): a URL
is a run of non-whitespace, so it may contain commas (data: URLs often do);
trailing commas end it; descriptors run to the next comma outside
parentheses.  Splitting on "," instead can turn part of one URL into a
separate, live candidate.  Candidates whose descriptors are not plain
density/width/height tokens (1x, 640w, 1.5x) are dropped.
*/
export function parseSrcset(input: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  const isSpace = (c: string) => /[\t\n\f\r ]/.test(c);
  let pos = 0;
  while (pos < input.length) {
    while (pos < input.length && (isSpace(input[pos]) || input[pos] === ",")) {
      pos++;
    }
    if (pos >= input.length) break;
    const start = pos;
    while (pos < input.length && !isSpace(input[pos])) pos++;
    let url = input.slice(start, pos);
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const descriptorStart = pos;
      let depth = 0;
      while (pos < input.length) {
        const c = input[pos];
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        pos++;
      }
      descriptors = input.slice(descriptorStart, pos).trim();
      pos++; // the comma
    }
    if (url && DESCRIPTORS.test(descriptors)) {
      candidates.push({ url, descriptors: descriptors.replace(/\s+/g, " ") });
    }
  }
  return candidates;
}

export function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptors }) =>
      descriptors ? `${url} ${descriptors}` : url,
    )
    .join(", ");
}

// Apply urlTransform to each candidate URL of a srcset, keeping descriptors
// and dropping rejected candidates.  Returns null if none remain.
export function applyUrlTransformToSrcset(
  urlTransform: UrlTransform | undefined,
  srcset: string,
  tag?: string,
): string | null {
  const candidates: SrcsetCandidate[] = [];
  for (const { url, descriptors } of parseSrcset(srcset)) {
    const transformed = applyUrlTransform(urlTransform, url, tag);
    if (transformed == null) continue;
    candidates.push({ url: transformed, descriptors });
  }
  return candidates.length > 0 ? serializeSrcset(candidates) : null;
}
