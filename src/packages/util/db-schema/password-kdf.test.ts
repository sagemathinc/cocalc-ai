/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { passwordKdfChangeError } from "./password-kdf";

describe("password_kdf is one-way", () => {
  it("allows legacy to scrypt and refuses scrypt to anything else", () => {
    expect(passwordKdfChangeError(undefined, "legacy")).toBeUndefined();
    expect(passwordKdfChangeError("legacy", "scrypt")).toBeUndefined();
    expect(passwordKdfChangeError("scrypt", "scrypt")).toBeUndefined();
    expect(passwordKdfChangeError("scrypt", "legacy")).toMatch(/one-way/);
    expect(passwordKdfChangeError("scrypt", "")).toMatch(/one-way/);
  });
});
