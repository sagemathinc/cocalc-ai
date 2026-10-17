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

// Returns the URL to use, or null if urlTransform rejected it.
export function applyUrlTransform(
  urlTransform: UrlTransform | undefined,
  url: string,
  tag?: string,
): string | null {
  if (urlTransform == null) {
    return url;
  }
  const result = urlTransform(url, tag);
  if (result === URL_REJECTED) {
    return null;
  }
  return result ?? url;
}
