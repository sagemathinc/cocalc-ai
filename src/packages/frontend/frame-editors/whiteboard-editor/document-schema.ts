/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Element } from "./types";
export { legacyEscapedMathDelimitersToText } from "@cocalc/util/misc";
import { legacyEscapedMathDelimitersToText } from "@cocalc/util/misc";

export const CURRENT_DOCUMENT_SCHEMA_VERSION = 1;

export function isLegacyDocumentSchemaVersion(version: unknown): boolean {
  return typeof version !== "number" || version < 1;
}

function isMarkdownElement(element: Element): boolean {
  return (
    element.type === "text" ||
    element.type === "note" ||
    element.type === "speaker_notes"
  );
}

export function normalizeLegacyTextElement(element: Element): Element {
  if (!isMarkdownElement(element) || element.str == null) {
    return element;
  }
  const str = legacyEscapedMathDelimitersToText(element.str);
  if (str === element.str) {
    return element;
  }
  return { ...element, str };
}
