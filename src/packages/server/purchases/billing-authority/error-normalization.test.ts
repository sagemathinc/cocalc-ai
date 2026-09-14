/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  BILLING_AUTHORITY_ERROR_CODE_MAX_BYTES,
  BILLING_AUTHORITY_ERROR_MESSAGE_MAX_BYTES,
  normalizeBillingAuthorityError,
  postgresSafeBoundedText,
} from "./error-normalization";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("billing authority error normalization", () => {
  it("truncates on a UTF-8 code-point boundary", () => {
    const normalized = postgresSafeBoundedText(
      `${"a".repeat(3997)}\u{1f600}`,
      BILLING_AUTHORITY_ERROR_MESSAGE_MAX_BYTES,
    );
    expect(normalized).toBe("a".repeat(3997));
    expect(isWellFormed(normalized)).toBe(true);
    expect(Buffer.byteLength(normalized, "utf8")).toBeLessThanOrEqual(
      BILLING_AUTHORITY_ERROR_MESSAGE_MAX_BYTES,
    );
  });

  it("replaces NUL and unpaired surrogates in messages and string codes", () => {
    const normalized = normalizeBillingAuthorityError({
      message: "before\0middle\ud800after",
      code: "code\0\udc00tail",
      status: 400,
    });
    expect(normalized).toEqual({
      message: "before\uFFFDmiddle\uFFFDafter",
      code: "code\uFFFD\uFFFDtail",
      status: 400,
    });
    expect(isWellFormed(normalized.message)).toBe(true);
    expect(isWellFormed(normalized.code as string)).toBe(true);
    expect(normalized.message).not.toContain("\0");
    expect(normalized.code).not.toContain("\0");
  });

  it("bounds codes by encoded bytes and safely falls back", () => {
    const normalized = normalizeBillingAuthorityError(undefined, {
      fallbackMessage: "fallback",
      fallbackCode: `${"c".repeat(253)}\u{1f600}`,
    });
    expect(normalized).toEqual({
      message: "fallback",
      code: "c".repeat(253),
    });
    expect(
      Buffer.byteLength(normalized.code as string, "utf8"),
    ).toBeLessThanOrEqual(BILLING_AUTHORITY_ERROR_CODE_MAX_BYTES);
  });
});
