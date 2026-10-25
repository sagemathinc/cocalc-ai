/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import {
  PasswordHashBusyError,
  checkPassword,
  hashPassword,
} from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { db } from "@cocalc/database";
import { getPasswordKdf } from "@cocalc/database/settings/password-kdf";
import { callback2 } from "@cocalc/util/async-utils";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import createAccount from "@cocalc/server/accounts/create-account";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  countLegacyPasswordHashes,
  runPasswordHashMigrationPass,
  wrapAccountPasswordHashes,
  wrapRecoveryCodeHashes,
} from "./password-hash-migration";
import { upgradePasswordHashAfterSignIn } from "./password-hash-upgrade";
import { verifyLocalSignInPassword } from "./verify-sign-in-password";

// The legacy format (what the code before scrypt wrote).
async function legacyHash(password: string): Promise<string> {
  return await hashPassword(password, { kdf: "legacy" });
}

async function setKdf(value: "legacy" | "scrypt") {
  await getPool().query(
    `INSERT INTO server_settings (name, value) VALUES ('password_kdf', $1)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    [value],
  );
  resetServerSettingsCache();
}

async function accountWithHash(password_hash: string | null) {
  const account_id = uuid();
  const email = `${uuid()}@example.com`;
  await createAccount({ email, firstName: "A", lastName: "B", account_id });
  await getPool().query(
    "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
    [password_hash, account_id],
  );
  return { account_id, email };
}

async function storedHash(account_id: string): Promise<string> {
  const { rows } = await getPool().query(
    "SELECT password_hash FROM accounts WHERE account_id=$1",
    [account_id],
  );
  return rows[0]?.password_hash;
}

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("password hash migration", () => {
  it("under legacy, writes legacy hashes and neither upgrades nor wraps", async () => {
    // First test: no scrypt hash exists yet in this database.
    await setKdf("legacy");
    expect(await getPasswordKdf()).toBe("legacy");
    const password = `pw-${uuid()}`;
    const old = await legacyHash(password);
    const signer = await accountWithHash(old);
    await verifyLocalSignInPassword({ email_address: signer.email, password });
    expect(await storedHash(signer.account_id)).toBe(old);
    const off = await runPasswordHashMigrationPass();
    expect(off.accounts.wrapped).toBe(0);
    expect(await storedHash(signer.account_id)).toBe(old);

    const { account_id } = await accountWithHash(null);
    const { default: setPassword } =
      await import("@cocalc/database/pool/account/set-password");
    await setPassword(account_id, "first password");
    expect((await storedHash(account_id)).startsWith("sha512$")).toBe(true);
    await setKdf("scrypt");
    await setPassword(account_id, "second password");
    const stored = await storedHash(account_id);
    expect(stored.startsWith("scrypt$v1$")).toBe(true);
    expect(await checkPassword("second password", stored)).toBe(true);
  });

  it("wraps legacy account hashes in place, idempotently", async () => {
    const password = `pw-${uuid()}`;
    const { account_id } = await accountWithHash(await legacyHash(password));
    const strong = await accountWithHash(
      await hashPassword("other", { kdf: "scrypt" }),
    );
    const strongBefore = await storedHash(strong.account_id);
    const none = await accountWithHash(null);

    const first = await wrapAccountPasswordHashes({ limit: 1000 });
    expect(first.wrapped).toBeGreaterThanOrEqual(1);
    const wrapped = await storedHash(account_id);
    expect(wrapped.startsWith("scrypt-wrap$v1$")).toBe(true);
    expect(await checkPassword(password, wrapped)).toBe(true);
    expect(await checkPassword(password + "x", wrapped)).toBe(false);
    expect(await storedHash(strong.account_id)).toBe(strongBefore);
    expect(await storedHash(none.account_id)).toBeNull();

    const again = await wrapAccountPasswordHashes({ limit: 1000 });
    expect(again.wrapped).toBe(0);
    expect(await storedHash(account_id)).toBe(wrapped);
  });

  it("resumes after any account and never touches a changed hash", async () => {
    const a = await accountWithHash(await legacyHash("a"));
    const b = await accountWithHash(await legacyHash("b"));
    const [first, second] = [a, b].sort((x, y) =>
      x.account_id < y.account_id ? -1 : 1,
    );
    // Resume after `first`: only accounts after it are visited.
    await wrapAccountPasswordHashes({ after: first.account_id, limit: 1000 });
    expect((await storedHash(first.account_id)).startsWith("sha512$")).toBe(
      true,
    );
    expect(
      (await storedHash(second.account_id)).startsWith("scrypt-wrap$"),
    ).toBe(true);
  });

  it("wraps recovery-code hashes", async () => {
    const { account_id } = await accountWithHash(null);
    const id = uuid();
    await getPool().query(
      `INSERT INTO account_second_factor_recovery_codes
         (id, account_id, factor_id, code_hash, used_at, created, metadata)
       VALUES ($1, $2, $3, $4, NULL, NOW(), '{}')`,
      [id, account_id, uuid(), await legacyHash("ABCD-EFGH")],
    );
    await wrapRecoveryCodeHashes({ limit: 1000 });
    const { rows } = await getPool().query(
      "SELECT code_hash FROM account_second_factor_recovery_codes WHERE id=$1",
      [id],
    );
    expect(rows[0].code_hash.startsWith("scrypt-wrap$v1$")).toBe(true);
    expect(await checkPassword("ABCD-EFGH", rows[0].code_hash)).toBe(true);
  });

  it("leaves no legacy hashes after a full pass under scrypt", async () => {
    await accountWithHash(await legacyHash("pass"));
    expect((await countLegacyPasswordHashes()).accounts).toBeGreaterThan(0);
    await setKdf("scrypt");
    await runPasswordHashMigrationPass();
    expect(await countLegacyPasswordHashes()).toEqual({
      accounts: 0,
      recovery_codes: 0,
    });
  });

  it("upgrades a legacy or wrapped hash to scrypt on sign-in", async () => {
    await setKdf("scrypt");
    const password = `pw-${uuid()}`;
    const { account_id, email } = await accountWithHash(
      await legacyHash(password),
    );
    await wrapAccountPasswordHashes({ limit: 1000 });
    expect((await storedHash(account_id)).startsWith("scrypt-wrap$")).toBe(
      true,
    );
    await verifyLocalSignInPassword({ email_address: email, password });
    const upgraded = await storedHash(account_id);
    expect(upgraded.startsWith("scrypt$v1$")).toBe(true);
    expect(await checkPassword(password, upgraded)).toBe(true);
    // Already strong: nothing to do.
    expect(
      await upgradePasswordHashAfterSignIn({
        account_id,
        password,
        password_hash: upgraded,
      }),
    ).toBe(false);
  });

  it("never upgrades over a newer hash", async () => {
    const password = `pw-${uuid()}`;
    const old = await legacyHash(password);
    const { account_id } = await accountWithHash(old);
    await setKdf("scrypt");
    // The password changed after this sign-in read the old hash: keep it.
    const newer = await hashPassword("changed", { kdf: "scrypt" });
    await getPool().query(
      "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
      [newer, account_id],
    );
    expect(
      await upgradePasswordHashAfterSignIn({
        account_id,
        password,
        password_hash: old,
      }),
    ).toBe(false);
    expect(await storedHash(account_id)).toBe(newer);
  });

  it("still rejects a wrong password in every format", async () => {
    await setKdf("scrypt");
    for (const stored of [
      await legacyHash("right"),
      await hashPassword("right", { kdf: "scrypt" }),
    ]) {
      const { email } = await accountWithHash(stored);
      await expect(
        verifyLocalSignInPassword({ email_address: email, password: "wrong" }),
      ).rejects.toThrow("incorrect");
    }
  });

  it("recovers when the first dummy hash could not be created (busy)", async () => {
    await setKdf("scrypt");
    // Fill admission (2 active, 32 waiting), then race the first
    // missing-account check, whose dummy hash creation is refused.
    const burst = Array.from({ length: 40 }, (_, i) =>
      hashPassword(`burst${i}`, { kdf: "scrypt" }),
    );
    await expect(
      verifyLocalSignInPassword({
        email_address: `${uuid()}@example.com`,
        password: "wrong",
      }),
    ).rejects.toBeInstanceOf(PasswordHashBusyError);
    await Promise.allSettled(burst);
    // Rebuilt, not cached as a rejection: the next check pays a KDF.
    const { email } = await accountWithHash(
      await hashPassword("right", { kdf: "scrypt" }),
    );
    const time = async (email_address: string) => {
      const start = Date.now();
      await expect(
        verifyLocalSignInPassword({ email_address, password: "wrong" }),
      ).rejects.toThrow();
      return Date.now() - start;
    };
    await time(`${uuid()}@example.com`);
    const real = await time(email);
    const missing = await time(`${uuid()}@example.com`);
    expect(missing).toBeGreaterThan(real / 3);
  });

  it("takes as long for a missing account as for a wrong password", async () => {
    await setKdf("scrypt");
    const { email } = await accountWithHash(
      await hashPassword("right", { kdf: "scrypt" }),
    );
    const time = async (email_address: string) => {
      const start = Date.now();
      await expect(
        verifyLocalSignInPassword({ email_address, password: "wrong" }),
      ).rejects.toThrow();
      return Date.now() - start;
    };
    await time(`${uuid()}@example.com`); // computes the dummy hash once
    const sso = await accountWithHash(null);
    const real = await time(email);
    const missing = await time(`${uuid()}@example.com`);
    const noPassword = await time(sso.email);
    // A legacy hash the migration has not wrapped yet.
    const unwrapped = await accountWithHash(await legacyHash("right"));
    const legacyRow = await time(unwrapped.email);
    // All pay one scrypt; without the dummy check they return in ~1-4 ms.
    expect(missing).toBeGreaterThan(real / 3);
    expect(noPassword).toBeGreaterThan(real / 3);
    expect(legacyRow).toBeGreaterThan(real / 3);
  });

  it("refuses to set password_kdf back to legacy once it is scrypt", async () => {
    const set = (value: string) =>
      callback2(db().set_server_setting, { name: "password_kdf", value });
    await set("scrypt");
    // The callback API rejects with the error message.
    await expect(set("legacy")).rejects.toEqual(
      expect.stringContaining("one-way"),
    );
    await set("scrypt"); // idempotent
    resetServerSettingsCache();
    expect(await getPasswordKdf()).toBe("scrypt");
  });

  it("keeps scrypt when activation races a stale legacy write", async () => {
    const set = (value: string) =>
      callback2(db().set_server_setting, { name: "password_kdf", value });
    const current = async () =>
      (
        await getPool().query(
          "SELECT value FROM server_settings WHERE name='password_kdf'",
        )
      ).rows[0]?.value;
    for (let i = 0; i < 10; i++) {
      // Start from legacy (only possible before activation, as here).
      await getPool().query(
        "UPDATE server_settings SET value='legacy' WHERE name='password_kdf'",
      );
      await Promise.allSettled([set("scrypt"), set("legacy"), set("legacy")]);
      expect(await current()).toBe("scrypt");
    }
  });
});
