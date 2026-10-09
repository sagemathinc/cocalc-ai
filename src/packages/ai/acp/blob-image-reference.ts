/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { asciiLowerCase } from "@cocalc/util/linear-text";

function isWordChar(char: string | undefined): boolean {
  if (char == null) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

// Whether an image reference to /blobs/ remains in the prompt: exactly
//   /(?:<img\b[^>]*\bsrc=|!\[[^\]]*\]\()[^\n]*\/blobs\//i.test(text)
// in one forward pass; that pattern was quadratic in the prompt length.
// An opener is "<img" (not followed by a word character) and then any
// word-bounded "src=" before the next ">", or "![" and then the next "]" if
// "(" follows it. Openers may span lines; "/blobs/" must follow on the line
// where the opener ends.
export function hasBlobImageReference(text: string): boolean {
  const lower = asciiLowerCase(text);
  let openImg = false; // "<img" seen since the last ">"
  let openBang = false; // "![" seen since the last "]"
  let opened = false; // an opener ended earlier on this line
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i];
    if (char === "\n") {
      opened = false;
    } else if (char === ">") {
      openImg = false;
    } else if (char === "]") {
      if (openBang && lower[i + 1] === "(") opened = true;
      openBang = false;
    } else if (lower.startsWith("<img", i) && !isWordChar(lower[i + 4])) {
      openImg = true;
    } else if (lower.startsWith("![", i)) {
      openBang = true;
    } else if (
      openImg &&
      lower.startsWith("src=", i) &&
      !isWordChar(lower[i - 1])
    ) {
      opened = true;
    } else if (opened && lower.startsWith("/blobs/", i)) {
      return true;
    }
  }
  return false;
}
