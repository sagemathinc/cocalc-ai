/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Every failed sign-in must cost the same KDF work, so response time does not
// reveal whether an account exists: count the KDF-bearing checks per path.

const mockQuery = jest.fn();
let mockKdf: "legacy" | "scrypt" = "legacy";
const checked: string[] = [];

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => mockQuery(...args) }),
}));
jest.mock("@cocalc/database/settings/password-kdf", () => ({
  getPasswordKdf: async () => mockKdf,
}));
jest.mock("@cocalc/server/auth/password-hash-upgrade", () => ({
  upgradePasswordHashAfterSignIn: async () => false,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/backend/auth/password-hash", () => {
  const actual = jest.requireActual("@cocalc/backend/auth/password-hash");
  return {
    ...actual,
    // Creating a hash costs one KDF too (the cold dummy).
    hashPassword: async (password: string, opts: any) => {
      const hash = await actual.hashPassword(password, opts);
      checked.push(hash.split("$")[0]);
      return hash;
    },
    checkPassword: async (password: string, stored: string) => {
      // Only well-formed hashes cost a KDF (malformed ones are rejected unparsed).
      if (actual.isPasswordHash(stored)) checked.push(stored.split("$")[0]);
      return await actual.checkPassword(password, stored);
    },
  };
});

import { hashPassword } from "@cocalc/backend/auth/password-hash";
import { verifyLocalSignInPassword } from "./verify-sign-in-password";

async function kdfChecksFor(row: object | undefined): Promise<string[]> {
  mockQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
  checked.length = 0;
  await expect(
    verifyLocalSignInPassword({
      email_address: "user@example.com",
      password: "wrong",
    }),
  ).rejects.toThrow();
  return [...checked];
}

describe("verifyLocalSignInPassword failure cost", () => {
  it.each(["legacy", "scrypt"] as const)(
    "pays exactly one %s KDF on every failure path",
    async (kdf) => {
      mockKdf = kdf;
      const account = (password_hash: string | null) => ({
        account_id: "a",
        password_hash,
        banned: false,
        home_bay_id: "bay-0",
      });
      const legacy = await hashPassword("right", { kdf: "legacy" });
      const scrypt = await hashPassword("right", { kdf: "scrypt" });
      const expensive = kdf === "scrypt" ? "scrypt" : "sha512";
      const count = (checks: string[]) =>
        checks.filter((c) => c === expensive || c === "scrypt-wrap").length;

      expect(count(await kdfChecksFor(undefined))).toBe(1); // missing, cold
      expect(count(await kdfChecksFor(undefined))).toBe(1); // missing, warm
      expect(count(await kdfChecksFor(account(null)))).toBe(1); // no password
      expect(count(await kdfChecksFor(account(legacy)))).toBe(1); // unwrapped
      if (kdf === "scrypt") {
        expect(count(await kdfChecksFor(account(scrypt)))).toBe(1);
        // A malformed strong-looking row also pays the dummy.
        expect(count(await kdfChecksFor(account("scrypt$v1$garbage")))).toBe(1);
      }
    },
  );
});
