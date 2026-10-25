/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generate } from "password-hash";
import {
  checkPassword,
  hashPassword,
  isPasswordHash,
  passwordNeedsRehash,
  tokenHash,
  verifyToken,
  wrapLegacyPasswordHash,
} from "./password-hash";

// The legacy format, written by the code before this change.
function legacy(password: string): string {
  return generate(password, {
    algorithm: "sha512",
    saltLength: 32,
    iterations: 1000,
  });
}

describe("password hashes", () => {
  const password = "correct horse battery staple";

  it("verifies every format and rejects a wrong password", async () => {
    const formats = {
      legacy: legacy(password),
      legacyNew: await hashPassword(password, { kdf: "legacy" }),
      scrypt: await hashPassword(password, { kdf: "scrypt" }),
      wrapped: (await wrapLegacyPasswordHash(legacy(password)))!,
    };
    expect(formats.scrypt.startsWith("scrypt$v1$")).toBe(true);
    expect(formats.wrapped.startsWith("scrypt-wrap$v1$")).toBe(true);
    for (const [name, stored] of Object.entries(formats)) {
      expect([name, await checkPassword(password, stored)]).toEqual([
        name,
        true,
      ]);
      expect([name, await checkPassword(password + "x", stored)]).toEqual([
        name,
        false,
      ]);
      expect([name, await checkPassword("", stored)]).toEqual([name, false]);
      expect(isPasswordHash(stored)).toBe(true);
      // Both database columns are VARCHAR(173).
      expect(stored.length).toBeLessThanOrEqual(173);
    }
  });

  it("uses a fresh salt every time (no plaintext cache)", async () => {
    for (const kdf of ["legacy", "scrypt"] as const) {
      const a = await hashPassword(password, { kdf });
      const b = await hashPassword(password, { kdf });
      expect(a).not.toBe(b);
    }
  });

  it("verifies the oldest legacy format without iterations", async () => {
    const stored = legacy(password).split("$");
    const oneRound = generate(password, {
      algorithm: "sha512",
      saltLength: 8,
      iterations: 1,
    }).split("$");
    expect(
      await checkPassword(
        password,
        [oneRound[0], oneRound[1], oneRound[3]].join("$"),
      ),
    ).toBe(true);
    expect(stored).toHaveLength(4);
  });

  it("rejects malformed and tampered hashes", async () => {
    const scrypt = await hashPassword(password, { kdf: "scrypt" });
    const parts = scrypt.split("$");
    for (const bad of [
      null,
      undefined,
      "",
      "garbage",
      "scrypt$v1$",
      "scrypt$v1$3$8$1$c2FsdA$a2V5", // N not a power of two
      "scrypt$v1$4194304$8$1$c2FsdA$a2V5", // N too large
      "scrypt-wrap$v1$32768$8$1$c2FsdA$a2V5$sha512$salt",
      [...parts.slice(0, 6), "AAAA"].join("$"),
    ]) {
      expect(await checkPassword(password, bad as any)).toBe(false);
    }
  });

  it("wraps only legacy hashes, idempotently", async () => {
    const stored = legacy(password);
    const wrapped = (await wrapLegacyPasswordHash(stored))!;
    expect(await wrapLegacyPasswordHash(wrapped)).toBeUndefined();
    expect(
      await wrapLegacyPasswordHash(
        await hashPassword(password, { kdf: "scrypt" }),
      ),
    ).toBeUndefined();
    expect(await wrapLegacyPasswordHash("not a hash")).toBeUndefined();
    // The wrap is scrypt over the old digest: the old salt stays.
    expect(wrapped.endsWith(`$sha512$${stored.split("$")[1]}$1000`)).toBe(true);
  });

  it("asks for a rehash only when writing scrypt", async () => {
    const scrypt = await hashPassword(password, { kdf: "scrypt" });
    const wrapped = (await wrapLegacyPasswordHash(legacy(password)))!;
    expect(passwordNeedsRehash(legacy(password), { kdf: "legacy" })).toBe(
      false,
    );
    expect(passwordNeedsRehash(wrapped, { kdf: "legacy" })).toBe(false);
    expect(passwordNeedsRehash(legacy(password), { kdf: "scrypt" })).toBe(true);
    expect(passwordNeedsRehash(wrapped, { kdf: "scrypt" })).toBe(true);
    expect(passwordNeedsRehash(scrypt, { kdf: "scrypt" })).toBe(false);
  });

  it("bounds concurrent scrypt work but completes every hash", async () => {
    const hashes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        hashPassword(`${password}${i}`, { kdf: "scrypt" }),
      ),
    );
    for (let i = 0; i < hashes.length; i++) {
      expect(await checkPassword(`${password}${i}`, hashes[i])).toBe(true);
    }
  });
});

describe("token hashes", () => {
  it("are the fast legacy format and verify synchronously", () => {
    const token = "a".repeat(40);
    const hash = tokenHash(token);
    expect(hash.startsWith("sha512$")).toBe(true);
    expect(verifyToken(token, hash)).toBe(true);
    expect(verifyToken(token + "b", hash)).toBe(false);
    expect(verifyToken(token, legacy(token))).toBe(true);
  });

  it("stay stable for a token for a while (lite auth cookie)", () => {
    const token = "b".repeat(40);
    expect(tokenHash(token)).toBe(tokenHash(token));
    expect(tokenHash(token)).not.toBe(tokenHash("c".repeat(40)));
  });

  it("stay fast", () => {
    const token = "d".repeat(40);
    const hash = legacy(token);
    const start = Date.now();
    for (let i = 0; i < 20; i++) verifyToken(token, hash);
    // 1000 HMAC rounds each: a few ms, nowhere near a slow KDF.
    expect((Date.now() - start) / 20).toBeLessThan(25);
  });
});
