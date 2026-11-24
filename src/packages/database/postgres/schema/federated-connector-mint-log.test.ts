/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  ensureFederatedMintLogSchema,
  federatedMintLogSchemaNeedsSync,
  getFederatedMintLogGuardStatus,
  purgeExpiredFederatedMintLog,
} from "./federated-connector-mint-log";

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedMintLogSchema(client);
  } finally {
    client.release();
  }
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

// Inserts a row, then (because a supplied time is always overwritten) moves
// its time with the row trigger disabled: a test-only way to make old rows.
async function insertAt(interval: string): Promise<string> {
  const id = await insert();
  await getPool().query(
    "ALTER TABLE federated_connector_mint_log DISABLE TRIGGER federated_connector_mint_log_append_only",
  );
  try {
    await getPool().query(
      `UPDATE federated_connector_mint_log SET time = NOW() - INTERVAL '${interval}' WHERE mint_id=$1`,
      [id],
    );
  } finally {
    await getPool().query(
      "ALTER TABLE federated_connector_mint_log ENABLE ALWAYS TRIGGER federated_connector_mint_log_append_only",
    );
  }
  return id;
}

async function insert(time = "NOW()"): Promise<string> {
  const mint_id = uuid();
  await getPool().query(
    `INSERT INTO federated_connector_mint_log
       (mint_id, time, outcome, reason, grant_id, grant_revision, lease_id, jti)
     VALUES ($1, ${time}, 'denied', 'revision', $2, 1, $3, $4)`,
    [mint_id, uuid(), uuid(), uuid()],
  );
  return mint_id;
}

async function count(mint_id: string): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT COUNT(*)::INT AS n FROM federated_connector_mint_log WHERE mint_id=$1",
    [mint_id],
  );
  return rows[0].n;
}

describe("federated connector mint log", () => {
  it("installs every guard, current and enabled", async () => {
    expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
      state: "ok",
    });
    expect(await federatedMintLogSchemaNeedsSync(getPool())).toBe(false);
  });

  it("is idempotent", async () => {
    const client = await getPool().connect();
    try {
      await ensureFederatedMintLogSchema(client);
    } finally {
      client.release();
    }
    expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
      state: "ok",
    });
  });

  it("accepts inserts", async () => {
    const id = await insert();
    expect(await count(id)).toBe(1);
  });

  it("refuses an update", async () => {
    const id = await insert();
    await expect(
      getPool().query(
        "UPDATE federated_connector_mint_log SET outcome='issued' WHERE mint_id=$1",
        [id],
      ),
    ).rejects.toThrow("append-only");
    const { rows } = await getPool().query(
      "SELECT outcome FROM federated_connector_mint_log WHERE mint_id=$1",
      [id],
    );
    expect(rows[0].outcome).toBe("denied");
  });

  it("overwrites a supplied time with the database clock", async () => {
    const id = await insert("NOW() - INTERVAL '14 months'");
    const { rows } = await getPool().query(
      "SELECT time > NOW() - INTERVAL '1 minute' AS recent FROM federated_connector_mint_log WHERE mint_id=$1",
      [id],
    );
    expect(rows[0].recent).toBe(true);
    // so a backdated record can't be deleted at once
    await expect(
      getPool().query(
        "DELETE FROM federated_connector_mint_log WHERE mint_id=$1",
        [id],
      ),
    ).rejects.toThrow("append-only");
    expect(await count(id)).toBe(1);
  });

  it("enables every guard ALWAYS, so replica-mode sessions are covered", async () => {
    const { rows } = await getPool().query(
      `SELECT tgname, tgenabled::text AS enabled FROM pg_trigger
        WHERE tgrelid='federated_connector_mint_log'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(rows).toEqual([
      { tgname: "federated_connector_mint_log_append_only", enabled: "A" },
      { tgname: "federated_connector_mint_log_insert_time", enabled: "A" },
      { tgname: "federated_connector_mint_log_no_truncate", enabled: "A" },
    ]);
  });

  it("reports a trigger enabled only for origin sessions, and sync upgrades it", async () => {
    await getPool().query(
      "ALTER TABLE federated_connector_mint_log ENABLE TRIGGER federated_connector_mint_log_no_truncate",
    );
    expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
      state: "outdated",
    });
    expect(await federatedMintLogSchemaNeedsSync(getPool())).toBe(true);
    const client = await getPool().connect();
    try {
      await ensureFederatedMintLogSchema(client);
    } finally {
      client.release();
    }
    expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
      state: "ok",
    });
  });

  it("refuses deleting a record younger than the retention period", async () => {
    const id = await insertAt("12 months");
    await expect(
      getPool().query(
        "DELETE FROM federated_connector_mint_log WHERE mint_id=$1",
        [id],
      ),
    ).rejects.toThrow("append-only");
    expect(await count(id)).toBe(1);
  });

  it("refuses truncate", async () => {
    await insert();
    await expect(
      getPool().query("TRUNCATE federated_connector_mint_log"),
    ).rejects.toThrow("append-only");
  });

  it("lets the retention job delete only expired records", async () => {
    const old = await insertAt("14 months");
    const recent = await insertAt("1 day");
    expect(
      await purgeExpiredFederatedMintLog(getPool()),
    ).toBeGreaterThanOrEqual(1);
    expect(await count(old)).toBe(0);
    expect(await count(recent)).toBe(1);
  });

  it("has no column that could hold a token", async () => {
    const { rows } = await getPool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='federated_connector_mint_log'`,
    );
    const columns = rows.map((r) => r.column_name);
    for (const forbidden of [
      "token",
      "access_token",
      "assertion",
      "jwt",
      "secret",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it("reports a disabled guard and does not repair it", async () => {
    await getPool().query(
      "ALTER TABLE federated_connector_mint_log DISABLE TRIGGER federated_connector_mint_log_append_only",
    );
    try {
      expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
        state: "disabled",
      });
      expect(await federatedMintLogSchemaNeedsSync(getPool())).toBe(false);
    } finally {
      await getPool().query(
        "ALTER TABLE federated_connector_mint_log ENABLE ALWAYS TRIGGER federated_connector_mint_log_append_only",
      );
    }
  });
});
