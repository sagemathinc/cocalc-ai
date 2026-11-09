/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureFederatedMintLogSchema } from "@cocalc/database/postgres/schema/federated-connector-mint-log";
import {
  AUDIENCE_TEST_KEY,
  isAllowlisted,
  loadGrant,
  recordMint,
  withLeaseLock,
} from "./db";

// Fake values only.
const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const ACCOUNT = UUID(2);
const CONNECTION = UUID(9);
const GRANT = UUID(7);
const SA = "reader-sa@example-project-1.iam.gserviceaccount.com";

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedMintLogSchema(client);
  } finally {
    client.release();
  }
  await getPool().query(
    `INSERT INTO federated_connector_connections
       (connection_id, account_id, provider, use_case, state,
        pool_project_number, pool_id, provider_id, setup_results)
     VALUES ($1, $2, 'gcp', 'ops', 'enabled', '123456789012', 'example-pool',
             'example-provider', $3)`,
    [CONNECTION, ACCOUNT, { [AUDIENCE_TEST_KEY]: "passed" }],
  );
  await getPool().query(
    `INSERT INTO federated_connector_grants
       (grant_id, connection_id, account_id, revision, service_account,
        sa_label, target_project, permission_profile, state,
        service_account_unique_id)
     VALUES ($1, $2, $3, 3, $4, 'read-only', 'example-project-1', 'read-only',
             'enabled', '111111111111111111111')`,
    [GRANT, CONNECTION, ACCOUNT, SA],
  );
  await getPool().query(
    `INSERT INTO federated_connector_allowlist
       (entry_id, provider, service_account, permission_profile,
        target_project, created_by)
     VALUES ($1, 'gcp', $2, 'read-only', 'example-project-1', $3)`,
    [UUID(20), SA, ACCOUNT],
  );
}, 30_000);

afterAll(async () => {
  await getPool().end();
});

describe("grant lookup", () => {
  it("loads the grant and its connection for the owning account", async () => {
    const loaded = await loadGrant({ account_id: ACCOUNT, grant_id: GRANT });
    expect(loaded?.grant).toEqual({
      grant_id: GRANT,
      account_id: ACCOUNT,
      connection_id: CONNECTION,
      revision: 3,
      state: "enabled",
      service_account: SA,
      sa_label: "read-only",
      target_project: "example-project-1",
      permission_profile: "read-only",
    });
    expect(loaded?.connection).toEqual({
      connection_id: CONNECTION,
      account_id: ACCOUNT,
      provider: "gcp",
      state: "enabled",
      audience_test_passed: true,
      provider_ref: {
        pool_project_number: "123456789012",
        pool_id: "example-pool",
        provider_id: "example-provider",
      },
    });
  });

  it("finds nothing for another account", async () => {
    expect(await loadGrant({ account_id: UUID(99), grant_id: GRANT })).toBe(
      null,
    );
  });

  it("treats an unrecorded audience test as not passed", async () => {
    await getPool().query(
      "UPDATE federated_connector_connections SET setup_results = '{}' WHERE connection_id=$1",
      [CONNECTION],
    );
    try {
      const loaded = await loadGrant({ account_id: ACCOUNT, grant_id: GRANT });
      expect(loaded?.connection.audience_test_passed).toBe(false);
    } finally {
      await getPool().query(
        "UPDATE federated_connector_connections SET setup_results = $2 WHERE connection_id=$1",
        [CONNECTION, { [AUDIENCE_TEST_KEY]: "passed" }],
      );
    }
  });

  it("treats an incomplete provider reference as unusable", async () => {
    await getPool().query(
      "UPDATE federated_connector_connections SET provider_id = NULL WHERE connection_id=$1",
      [CONNECTION],
    );
    try {
      const loaded = await loadGrant({ account_id: ACCOUNT, grant_id: GRANT });
      expect(loaded?.connection.state).toBe("incomplete");
    } finally {
      await getPool().query(
        "UPDATE federated_connector_connections SET provider_id = 'example-provider' WHERE connection_id=$1",
        [CONNECTION],
      );
    }
  });
});

describe("allowlist", () => {
  it("matches only an exact entry", async () => {
    const entry = {
      provider: "gcp",
      service_account: SA,
      permission_profile: "read-only",
      target_project: "example-project-1",
    };
    expect(await isAllowlisted(entry)).toBe(true);
    expect(await isAllowlisted({ ...entry, permission_profile: "patch" })).toBe(
      false,
    );
    expect(
      await isAllowlisted({ ...entry, target_project: "example-project-2" }),
    ).toBe(false);
  });
});

describe("mint log", () => {
  it("records a row with the database's time and the given token times", async () => {
    await recordMint({
      outcome: "issued",
      reason: null,
      site_id: UUID(1),
      account_id: ACCOUNT,
      agent_id: UUID(3),
      project_id: UUID(4),
      host_id: UUID(5),
      run_id: UUID(6),
      connection_id: CONNECTION,
      grant_id: GRANT,
      grant_revision: 3,
      lease_id: UUID(30),
      jti: UUID(31),
      key_version:
        "projects/example-project-1/locations/us/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      service_account: SA,
      issued_at: 1_800_000_000_000,
      expires_at: 1_800_000_900_000,
    });
    const { rows } = await getPool().query(
      `SELECT outcome, time > NOW() - INTERVAL '1 minute' AS recent,
              EXTRACT(EPOCH FROM issued_at)::BIGINT AS issued,
              EXTRACT(EPOCH FROM expires_at)::BIGINT AS expires
         FROM federated_connector_mint_log WHERE lease_id=$1`,
      [UUID(30)],
    );
    expect(rows).toEqual([
      {
        outcome: "issued",
        recent: true,
        issued: "1800000000",
        expires: "1800000900",
      },
    ]);
  });

  it("records a denial without token times", async () => {
    await recordMint({
      outcome: "denied",
      reason: "not_allowlisted",
      site_id: UUID(1),
      account_id: ACCOUNT,
      agent_id: UUID(3),
      project_id: UUID(4),
      host_id: UUID(5),
      run_id: UUID(6),
      connection_id: null,
      grant_id: GRANT,
      grant_revision: 3,
      lease_id: UUID(32),
      jti: null,
      key_version: null,
      service_account: null,
      issued_at: null,
      expires_at: null,
    });
    const { rows } = await getPool().query(
      "SELECT outcome, reason, issued_at FROM federated_connector_mint_log WHERE lease_id=$1",
      [UUID(32)],
    );
    expect(rows).toEqual([
      { outcome: "denied", reason: "not_allowlisted", issued_at: null },
    ]);
  });
});

describe("lease lock", () => {
  it("runs one holder at a time for a lease", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withLeaseLock(UUID(40), async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withLeaseLock(UUID(40), async () => {
      order.push("second");
    });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("releases the lock when the holder throws", async () => {
    await expect(
      withLeaseLock(UUID(41), async () => {
        throw Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withLeaseLock(UUID(41), async () => "ok")).resolves.toBe("ok");
  });
});

describe("grant unique id", () => {
  const insertGrant = (state: string, uid: string | null) =>
    getPool().query(
      `INSERT INTO federated_connector_grants
         (grant_id, connection_id, account_id, revision, service_account,
          sa_label, target_project, permission_profile, state,
          service_account_unique_id)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, 'read-only',
               'example-project-1', 'read-only', $4, $5)`,
      [CONNECTION, ACCOUNT, SA, state, uid],
    );

  it("is required to enable a grant, and must be a decimal string", async () => {
    await expect(insertGrant("enabled", null)).rejects.toThrow();
    for (const bad of ["0123456789", "12345", "1e21", "abc", "1".repeat(33)]) {
      await expect(insertGrant("pending", bad)).rejects.toThrow();
    }
    await insertGrant("pending", null);
    await insertGrant("enabled", "222222222222222222222");
  });
});
