/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { BillingAuthorityError } from "./protocol";

export const BILLING_AUTHORITY_ERROR_MESSAGE_MAX_BYTES = 4000;
export const BILLING_AUTHORITY_ERROR_CODE_MAX_BYTES = 256;

const REPLACEMENT_CHARACTER = "\uFFFD";

function stringValue(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return fallback;
  }
}

function property(value: unknown, name: string): unknown {
  if (
    (typeof value !== "object" || value == null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * PostgreSQL JSONB rejects NUL and malformed UTF-16. Bound by encoded bytes so
 * truncation also cannot split a Unicode code point.
 */
export function postgresSafeBoundedText(
  value: unknown,
  maxBytes: number,
  fallback = "",
): string {
  const source = stringValue(value, fallback);
  const limit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.floor(maxBytes))
    : 0;
  const output: string[] = [];
  let bytes = 0;
  for (const character of source) {
    const codePoint = character.codePointAt(0)!;
    const safeCharacter =
      codePoint === 0 ||
      (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? REPLACEMENT_CHARACTER
        : character;
    const characterBytes = Buffer.byteLength(safeCharacter, "utf8");
    if (bytes + characterBytes > limit) break;
    output.push(safeCharacter);
    bytes += characterBytes;
  }
  return output.join("");
}

export function normalizeBillingAuthorityError(
  error: unknown,
  {
    fallbackMessage = "billing authority command failed",
    fallbackCode,
  }: {
    fallbackMessage?: string;
    fallbackCode?: number | string;
  } = {},
): BillingAuthorityError {
  const message = property(error, "message");
  const rawCode = property(error, "code");
  const rawStatus = property(error, "status");
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? rawCode
      : typeof rawCode === "string"
        ? postgresSafeBoundedText(
            rawCode,
            BILLING_AUTHORITY_ERROR_CODE_MAX_BYTES,
          )
        : fallbackCode;
  const normalizedCode =
    typeof code === "string"
      ? postgresSafeBoundedText(code, BILLING_AUTHORITY_ERROR_CODE_MAX_BYTES)
      : typeof code === "number" && Number.isFinite(code)
        ? code
        : undefined;
  return {
    message: postgresSafeBoundedText(
      message ?? error,
      BILLING_AUTHORITY_ERROR_MESSAGE_MAX_BYTES,
      fallbackMessage,
    ),
    ...(normalizedCode == null ? {} : { code: normalizedCode }),
    ...(typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? { status: rawStatus }
      : {}),
  };
}
