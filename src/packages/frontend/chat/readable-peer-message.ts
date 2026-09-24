/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function readablePeerMessage(body: string): {
  text: string;
  structured: boolean;
} {
  try {
    const value = JSON.parse(body);
    if (
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.text === "string" &&
      value.text.trim()
    ) {
      return { text: value.text, structured: true };
    }
  } catch {
    // Plain text is already readable.
  }
  return { text: body, structured: false };
}
