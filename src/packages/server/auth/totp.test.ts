/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import {
  base32Decode,
  base32Encode,
  buildTotpOtpauthUrl,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "./totp";

describe("totp helpers", () => {
  it("round-trips base32 secrets", () => {
    const input = Buffer.from("hello world");
    const encoded = base32Encode(input);
    expect(base32Decode(encoded).toString("utf8")).toBe("hello world");
  });

  it("verifies a known RFC6238 test vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(
      verifyTotpCode({
        secret,
        code: "287082",
        at: 59_000,
        window: 0,
      }),
    ).toBe(true);
    expect(
      verifyTotpCode({
        secret,
        code: "287083",
        at: 59_000,
        window: 0,
      }),
    ).toBe(false);
  });

  it("normalizes recovery codes", () => {
    expect(normalizeRecoveryCode(" abcd-efgh-ijkl ")).toBe("ABCDEFGHIJKL");
  });

  it("generates unique recovery codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it("builds otpauth urls", () => {
    const url = buildTotpOtpauthUrl({
      issuer: "CoCalc",
      accountLabel: "user@example.com",
      secret: "ABCDEF",
    });
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain("issuer=CoCalc");
    expect(url).toContain("secret=ABCDEF");
  });
});
