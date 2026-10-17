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

// Apply urlTransform to each candidate URL of a srcset, keeping descriptors
// and dropping rejected candidates.  Returns null if none remain.
export function applyUrlTransformToSrcset(
  urlTransform: UrlTransform | undefined,
  srcset: string,
  tag?: string,
): string | null {
  const candidates: string[] = [];
  for (const part of srcset.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [url, ...descriptors] = trimmed.split(/\s+/);
    const transformed = applyUrlTransform(urlTransform, url, tag);
    if (transformed == null) continue;
    candidates.push([transformed, ...descriptors].join(" "));
  }
  return candidates.length > 0 ? candidates.join(", ") : null;
}
