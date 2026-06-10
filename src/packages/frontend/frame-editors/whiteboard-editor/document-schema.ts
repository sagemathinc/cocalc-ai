/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Element } from "./types";

export const CURRENT_DOCUMENT_SCHEMA_VERSION = 1;

export function isLegacyDocumentSchemaVersion(version: unknown): boolean {
  return typeof version !== "number" || version < 1;
}

export function legacyEscapedMathDelimitersToText(value: string): string {
  return value.replace(/\\([()[\]])/g, "$1");
}

export function normalizeLegacyTextElement(element: Element): Element {
  if (element.type !== "text" || element.str == null) {
    return element;
  }
  const str = legacyEscapedMathDelimitersToText(element.str);
  if (str === element.str) {
    return element;
  }
  return { ...element, str };
}
