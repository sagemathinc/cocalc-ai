/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import registrationTokensQuery from "@cocalc/database/postgres/account/registration-tokens";
import {
  isEncryptedRegistrationTokenValue,
  isHashedRegistrationTokenValue,
  storedRegistrationTokenMatches,
} from "@cocalc/database/postgres/account/registration-token-secret";
import { resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import { ensureBootstrapAdminToken } from "@cocalc/server/auth/bootstrap-admin";
import { validateRegistrationTokenDirect } from "./redeem";

function queryDb() {
  return {
    _query: (opts: {
      query: string;
      params?: any[];
      cb: (err?: Error | null, result?: any) => void;
    }) => {
      getPool()
        .query(opts.query, opts.params)
        .then((result) => opts.cb(null, result))
        .catch((err) => opts.cb(err));
    },
  } as any;
}

async function rawRegistrationTokenRows() {
  const { rows } = await getPool().query(
    `SELECT token, descr, customize
       FROM registration_tokens
      ORDER BY descr NULLS LAST, token`,
  );
  return rows;
}

async function requireRegistrationTokens() {
  await getPool().query(
    `INSERT INTO server_settings (name, value)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
    ["public_signup_without_registration_token", "false"],
  );
  resetServerSettingsCache();
}

describe("registration token storage protection", () => {
  const originalSiteMasterKeyPath = process.env.COCALC_SITE_MASTER_KEY_PATH;
  let secretDir: string;

  beforeAll(async () => {
    secretDir = mkdtempSync(join(tmpdir(), "cocalc-registration-tokens-"));
    process.env.COCALC_SITE_MASTER_KEY_PATH = join(
      secretDir,
      "site-master-key",
    );
    await initEphemeralDatabase();
  }, 15000);

  beforeEach(async () => {
    await getPool().query(
      "TRUNCATE registration_tokens, accounts, server_settings CASCADE",
    );
    await requireRegistrationTokens();
  });

  afterAll(async () => {
    await getPool().end();
    if (originalSiteMasterKeyPath == null) {
      delete process.env.COCALC_SITE_MASTER_KEY_PATH;
    } else {
      process.env.COCALC_SITE_MASTER_KEY_PATH = originalSiteMasterKeyPath;
    }
    rmSync(secretDir, { recursive: true, force: true });
  });

  it("encrypts normal registration tokens at rest but returns cleartext to admins", async () => {
    await registrationTokensQuery(queryDb(), [], {
      token: "normal-token",
      descr: "Normal Token",
      limit: 5,
    });

    const rawRows = await rawRegistrationTokenRows();
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].token).not.toBe("normal-token");
    expect(isEncryptedRegistrationTokenValue(rawRows[0].token)).toBe(true);
    expect(isHashedRegistrationTokenValue(rawRows[0].token)).toBe(false);

    const visibleRows = await registrationTokensQuery(queryDb(), [], {
      token: "*",
    });
    expect(visibleRows).toMatchObject([
      {
        token: "normal-token",
        descr: "Normal Token",
        limit: 5,
      },
    ]);
  });

  it("opportunistically encrypts legacy plaintext tokens when validated", async () => {
    await getPool().query(
      `INSERT INTO registration_tokens (token, descr, disabled)
       VALUES ($1, $2, false)`,
      ["legacy-token", "Legacy Token"],
    );

    await expect(
      validateRegistrationTokenDirect("legacy-token"),
    ).resolves.toMatchObject({
      token: "legacy-token",
    });

    const rawRows = await rawRegistrationTokenRows();
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].token).not.toBe("legacy-token");
    expect(isEncryptedRegistrationTokenValue(rawRows[0].token)).toBe(true);
    await expect(
      storedRegistrationTokenMatches(rawRows[0].token, "legacy-token"),
    ).resolves.toBe(true);
  });

  it("stores bootstrap-admin tokens hash-only and hides them from admin token listing", async () => {
    const url = await ensureBootstrapAdminToken({
      baseUrl: "https://cocalc.example/",
    });

    expect(url).toBeDefined();
    const clearToken = new URL(url!).searchParams.get("registrationToken");
    expect(clearToken).toBeTruthy();

    const rawRows = await rawRegistrationTokenRows();
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].descr).toBe("Bootstrap Admin");
    expect(isHashedRegistrationTokenValue(rawRows[0].token)).toBe(true);
    expect(isEncryptedRegistrationTokenValue(rawRows[0].token)).toBe(false);
    await expect(
      storedRegistrationTokenMatches(rawRows[0].token, clearToken!),
    ).resolves.toBe(true);

    const visibleRows = await registrationTokensQuery(queryDb(), [], {
      token: "*",
    });
    expect(visibleRows).toEqual([]);
  });
});
