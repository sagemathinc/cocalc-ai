/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it.each(["seed", "attached"])(
    "never decides automatically in a multibay cluster (%s)",
    async (role) => {
      await unset();
      const saved = process.env.COCALC_CLUSTER_ROLE;
      process.env.COCALC_CLUSTER_ROLE = role;
      try {
        expect(await initPasswordKdfDefault({ fresh: true })).toBeUndefined();
        expect(await stored()).toBeUndefined();
      } finally {
        if (saved == null) delete process.env.COCALC_CLUSTER_ROLE;
        else process.env.COCALC_CLUSTER_ROLE = saved;
      }
    },
  );

  it("hashes accounts created after it in the chosen format", async () => {
    await unset();
    await initPasswordKdfDefault({ fresh: true });
    const account_id = uuid();
    await createAccount({
      email: `${uuid()}@example.com`,
      password: "first admin password",
      firstName: "A",
      lastName: "B",
      account_id,
    });
    const { rows } = await getPool().query(
      "SELECT password_hash FROM accounts WHERE account_id=$1",
      [account_id],
    );
    expect(rows[0].password_hash.startsWith("scrypt$v1$")).toBe(true);
  });

  it.each([
    ["rocket/bin/bay-migrate-schema.js"],
    ["../scripts/bay-systemd/bin/bay-migrate-schema.js"],
  ])("runs in %s after env and schema, before on-prem setup", (file) => {
    const src = readFileSync(join(__dirname, "..", "..", file), "utf8");
    const env = src.indexOf("await load_server_settings_from_env(");
    const schema = src.indexOf("await db.update_schema();");
    const init = src.indexOf("await initPasswordKdfDefaultAfterSchema();");
    const onprem = src.indexOf("await initialOnPremSetup(");
    for (const i of [env, schema, init, onprem]) expect(i).toBeGreaterThan(0);
    expect(env).toBeLessThan(init);
    expect(schema).toBeLessThan(init);
    expect(init).toBeLessThan(onprem);
  });

  it("runs in hub startup after env loading and before on-prem account setup", () => {
    // The bootstrap admin (initialOnPremSetup) must be hashed in the chosen
    // format, and an explicit environment value must be applied first.
    const hub = readFileSync(
      join(__dirname, "..", "..", "hub", "hub.ts"),
      "utf8",
    );
    const measure = hub.indexOf("hasNoPasswordHashes().catch");
    const env = hub.indexOf("await load_server_settings_from_env(");
    const init = hub.indexOf("await initPasswordKdfDefault(");
    const onprem = hub.indexOf("await initialOnPremSetup(");
    for (const i of [measure, env, init, onprem]) expect(i).toBeGreaterThan(0);
    expect(measure).toBeLessThan(env);
    expect(env).toBeLessThan(init);
    expect(init).toBeLessThan(onprem);
  });
});
