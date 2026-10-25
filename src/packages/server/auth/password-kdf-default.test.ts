/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { hashPassword } from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { getPasswordKdf } from "@cocalc/database/settings/password-kdf";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import createAccount from "@cocalc/server/accounts/create-account";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  hasNoPasswordHashes,
  initPasswordKdfDefault,
} from "./password-kdf-default";

async function unset() {
  await getPool().query(
    "DELETE FROM server_settings WHERE name='password_kdf'",
  );
  resetServerSettingsCache();
}

async function stored(): Promise<string | undefined> {
  const { rows } = await getPool().query(
    "SELECT value FROM server_settings WHERE name='password_kdf'",
  );
  return rows[0]?.value;
}

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("password_kdf default", () => {
  it("starts a fresh install on scrypt, persisted", async () => {
    await unset();
    expect(await hasNoPasswordHashes()).toBe(true);
    expect(await initPasswordKdfDefault({ fresh: true })).toBe("scrypt");
    expect(await stored()).toBe("scrypt");
    expect(await getPasswordKdf()).toBe("scrypt");
    // Startup again (e.g. after an upgrade): unchanged.
    expect(await initPasswordKdfDefault({ fresh: false })).toBe("scrypt");
  });

  it("keeps a deployment that already has password hashes on legacy", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${uuid()}@example.com`,
      firstName: "A",
      lastName: "B",
      account_id,
    });
    await getPool().query(
      "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
      [await hashPassword("pw", { kdf: "legacy" }), account_id],
    );
    await unset();
    expect(await hasNoPasswordHashes()).toBe(false);
    expect(await initPasswordKdfDefault({ fresh: false })).toBe("legacy");
    expect(await stored()).toBe("legacy");
    expect(await getPasswordKdf()).toBe("legacy");
  });

  it("never changes an explicit value", async () => {
    await unset();
    await getPool().query(
      "INSERT INTO server_settings (name, value) VALUES ('password_kdf', 'legacy')",
    );
    expect(await initPasswordKdfDefault({ fresh: true })).toBe("legacy");
    expect(await stored()).toBe("legacy");
    await getPool().query(
      "UPDATE server_settings SET value='scrypt' WHERE name='password_kdf'",
    );
    expect(await initPasswordKdfDefault({ fresh: false })).toBe("scrypt");
    expect(await stored()).toBe("scrypt");
  });

  it("decides only on the seed bay", async () => {
    await unset();
    const saved = process.env.COCALC_CLUSTER_SEED_BAY_ID;
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "some-other-seed";
    try {
      expect(await initPasswordKdfDefault({ fresh: true })).toBeUndefined();
      expect(await stored()).toBeUndefined();
    } finally {
      if (saved == null) delete process.env.COCALC_CLUSTER_SEED_BAY_ID;
      else process.env.COCALC_CLUSTER_SEED_BAY_ID = saved;
    }
  });
});
