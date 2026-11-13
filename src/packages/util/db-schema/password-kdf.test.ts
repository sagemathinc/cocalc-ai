/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  PASSWORD_KDF_ONE_WAY_ERROR,
  isPasswordKdfOneWayError,
  passwordKdfChangeError,
} from "./password-kdf";

describe("password_kdf is one-way", () => {
  it("allows legacy to scrypt and refuses scrypt to anything else", () => {
    expect(passwordKdfChangeError(undefined, "legacy")).toBeUndefined();
    expect(passwordKdfChangeError("legacy", "scrypt")).toBeUndefined();
    expect(passwordKdfChangeError("scrypt", "scrypt")).toBeUndefined();
    expect(passwordKdfChangeError("scrypt", "legacy")).toMatch(/one-way/);
    expect(passwordKdfChangeError("scrypt", "")).toMatch(/one-way/);
  });

  it("recognizes only the one-way refusal", () => {
    expect(isPasswordKdfOneWayError(PASSWORD_KDF_ONE_WAY_ERROR)).toBe(true);
    expect(
      isPasswordKdfOneWayError(new Error(PASSWORD_KDF_ONE_WAY_ERROR)),
    ).toBe(true);
    expect(isPasswordKdfOneWayError("connection refused")).toBe(false);
    expect(isPasswordKdfOneWayError(new Error("decrypt failed"))).toBe(false);
    expect(isPasswordKdfOneWayError(undefined)).toBe(false);
  });
});
