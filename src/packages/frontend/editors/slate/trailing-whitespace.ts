/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function removeTrailingMarkdownBlankWhitespace(value: string): string {
  return value.replace(/(?:[ \t]*\r?\n)+[ \t]*$/g, "");
}

export function differsOnlyByTrailingMarkdownBlankWhitespace(
  before: string,
  after: string,
): boolean {
  return (
    before !== after &&
    removeTrailingMarkdownBlankWhitespace(before) ===
      removeTrailingMarkdownBlankWhitespace(after)
  );
}

export function preserveSourceForTrailingBlankWhitespaceOnly({
  source,
  normalized,
}: {
  source: string;
  normalized: string;
}): string {
  return differsOnlyByTrailingMarkdownBlankWhitespace(source, normalized)
    ? source
    : normalized;
}
