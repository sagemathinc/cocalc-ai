/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { generate } from "password-hash";

import {
  checkPassword,
  hashPassword,
} from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
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

function legacy(password: string): string {
  return generate(password, {
    algorithm: "sha512",
    saltLength: 32,
    iterations: 1000,
  });
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
  it("writes legacy hashes until password_kdf is scrypt", async () => {
    await setKdf("legacy");
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
    const { account_id } = await accountWithHash(legacy(password));
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
    const a = await accountWithHash(legacy("a"));
    const b = await accountWithHash(legacy("b"));
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
      [id, account_id, uuid(), legacy("ABCD-EFGH")],
    );
    await wrapRecoveryCodeHashes({ limit: 1000 });
    const { rows } = await getPool().query(
      "SELECT code_hash FROM account_second_factor_recovery_codes WHERE id=$1",
      [id],
    );
    expect(rows[0].code_hash.startsWith("scrypt-wrap$v1$")).toBe(true);
    expect(await checkPassword("ABCD-EFGH", rows[0].code_hash)).toBe(true);
  });

  it("runs a full pass only while password_kdf is scrypt", async () => {
    await accountWithHash(legacy("pass"));
    await setKdf("legacy");
    const off = await runPasswordHashMigrationPass();
    expect(off.accounts.wrapped).toBe(0);
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
    const { account_id, email } = await accountWithHash(legacy(password));
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

  it("does not upgrade while password_kdf is legacy, or over a newer hash", async () => {
    await setKdf("legacy");
    const password = `pw-${uuid()}`;
    const old = legacy(password);
    const { account_id, email } = await accountWithHash(old);
    await verifyLocalSignInPassword({ email_address: email, password });
    expect(await storedHash(account_id)).toBe(old);

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
      legacy("right"),
      await hashPassword("right", { kdf: "scrypt" }),
    ]) {
      const { email } = await accountWithHash(stored);
      await expect(
        verifyLocalSignInPassword({ email_address: email, password: "wrong" }),
      ).rejects.toThrow("incorrect");
    }
  });
});
