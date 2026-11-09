/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The federated connector gate changes atomically with its audit row, on
// the seed, by an admin with fresh authentication. Fake values only.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureFederatedConnectorGuards } from "@cocalc/database/postgres/schema/federated-connector-guards";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
let bay = "seed";

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bay,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
  getConfiguredClusterId: () => "cluster-1",
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: async (account_id: string) => account_id === ADMIN,
}));
const freshAuth = jest.fn(async (_opts: any) => ({
  session_hash: "fake-session-hash-value",
  account_id: ADMIN,
  factor_verified_at: new Date("2026-11-09T05:00:00Z"),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (opts: any) => freshAuth(opts),
}));
const propagate = jest.fn(async (..._args: any[]) => ({}));
const recordEvent = jest.fn(async (..._args: any[]) => 7);
jest.mock("@cocalc/server/conat/api/system", () => ({
  SERVER_SETTINGS_CONFIG_SCOPE: "server_settings",
  propagateSiteSettingsToBays: (...args: any[]) => propagate(...args),
  recordGlobalConfigEventOnSeed: (...args: any[]) => recordEvent(...args),
}));

import { setFederatedAuditSessionKeyForTesting } from "./audit";
import {
  applyFederatedGateReplica,
  setFederatedConnectorGateOnSeed,
  setFederatedProtectedSettingOnSeed,
} from "./site-gate";

const q = (sql: string, params: any[] = []) => getPool().query(sql, params);

async function gateValue(): Promise<string | undefined> {
  const { rows } = await q(
    `SELECT value FROM server_settings WHERE name='federated_cli_connectors'`,
  );
  return rows[0]?.value;
}

async function gateAudits() {
  const { rows } = await q(
    `SELECT * FROM federated_connector_assignment_audit
      WHERE action='site-gate-change' ORDER BY time`,
  );
  return rows;
}

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedConnectorGuards(
      client,
      new Set(["federated_connector_assignment_audit"]),
    );
  } finally {
    client.release();
  }
  setFederatedAuditSessionKeyForTesting(Buffer.alloc(32, 9));
}, 30_000);

afterAll(async () => {
  await getPool().end();
});

beforeEach(() => {
  bay = "seed";
  propagate.mockClear();
  recordEvent.mockClear();
});

describe("federated connector gate", () => {
  it("turns gcloud on with one audit row, then propagates", async () => {
    await expect(
      setFederatedConnectorGateOnSeed({
        account_id: ADMIN,
        connectors: ["gcloud"],
      }),
    ).resolves.toEqual({ connectors: ["gcloud"] });
    expect(await gateValue()).toBe("gcloud");
    const audits = await gateAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_account_id: ADMIN,
      before: { connectors: [] },
      after: { connectors: ["gcloud"] },
    });
    expect(audits[0].session_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(freshAuth).toHaveBeenCalledWith(
      expect.objectContaining({ require_second_factor: true }),
    );
    expect(propagate).toHaveBeenCalledWith(
      [{ name: "federated_cli_connectors", value: "gcloud" }],
      { scope: "server_settings", version: 7 },
    );
  });

  it("an audit failure leaves the gate unchanged and propagates nothing", async () => {
    await q(
      `ALTER TABLE federated_connector_assignment_audit ADD CONSTRAINT fail_all CHECK (false) NOT VALID`,
    );
    try {
      await expect(
        setFederatedConnectorGateOnSeed({ account_id: ADMIN, connectors: [] }),
      ).rejects.toThrow();
    } finally {
      await q(
        `ALTER TABLE federated_connector_assignment_audit DROP CONSTRAINT fail_all`,
      );
    }
    expect(await gateValue()).toBe("gcloud");
    expect(await gateAudits()).toHaveLength(1);
    expect(propagate).not.toHaveBeenCalled();
  });

  it("turns it off, audited", async () => {
    await setFederatedConnectorGateOnSeed({
      account_id: ADMIN,
      connectors: [],
    });
    expect(await gateValue()).toBe("");
    expect((await gateAudits()).at(-1)).toMatchObject({
      before: { connectors: ["gcloud"] },
      after: { connectors: [] },
    });
  });

  it("refuses a non-admin, another bay, unknown names, no change, and no fresh auth", async () => {
    await expect(
      setFederatedConnectorGateOnSeed({
        account_id: USER,
        connectors: ["gcloud"],
      }),
    ).rejects.toThrow(/only an admin/);
    bay = "attached-a";
    await expect(
      setFederatedConnectorGateOnSeed({
        account_id: ADMIN,
        connectors: ["gcloud"],
      }),
    ).rejects.toThrow(/seed bay/);
    bay = "seed";
    await expect(
      setFederatedConnectorGateOnSeed({
        account_id: ADMIN,
        connectors: ["aws"],
      }),
    ).rejects.toThrow(/unknown federated connector/);
    await expect(
      setFederatedConnectorGateOnSeed({ account_id: ADMIN, connectors: [] }),
    ).rejects.toThrow(/nothing to change/);
    freshAuth.mockRejectedValueOnce(new Error("fresh authentication required"));
    await expect(
      setFederatedConnectorGateOnSeed({
        account_id: ADMIN,
        connectors: ["gcloud"],
      }),
    ).rejects.toThrow(/fresh authentication/);
    expect(await gateValue()).toBe("");
    expect(await gateAudits()).toHaveLength(2);
  });

  it("refuses a gate set by configuration", async () => {
    await q(
      `UPDATE server_settings SET readonly=true WHERE name='federated_cli_connectors'`,
    );
    try {
      await expect(
        setFederatedConnectorGateOnSeed({
          account_id: ADMIN,
          connectors: ["gcloud"],
        }),
      ).rejects.toThrow(/set by configuration/);
    } finally {
      await q(
        `UPDATE server_settings SET readonly=false WHERE name='federated_cli_connectors'`,
      );
    }
  });
});

describe("gate replication to another bay", () => {
  const seedCaller = {
    cluster_id: "cluster-1",
    bay_id: "seed",
    bay_credential_id: "cred-1",
  };

  it("accepts the value only from the seed bay of this cluster", async () => {
    bay = "attached-a";
    const refused = [
      undefined,
      {},
      { ...seedCaller, bay_id: "attached-b" },
      { ...seedCaller, cluster_id: "cluster-2" },
      { ...seedCaller, bay_credential_id: "" },
      { account_id: ADMIN },
    ];
    for (const caller of refused) {
      await expect(
        applyFederatedGateReplica({ value: "gcloud" }, caller as any),
      ).rejects.toThrow(/must come from the seed bay/);
    }
    expect(await gateValue()).toBe("");

    await applyFederatedGateReplica({ value: "gcloud" }, seedCaller);
    expect(await gateValue()).toBe("gcloud");
    await applyFederatedGateReplica({ value: "" }, seedCaller);
    expect(await gateValue()).toBe("");
  });

  it("refuses malformed values, and replication into the seed itself", async () => {
    bay = "attached-a";
    for (const value of ["aws", "gcloud,aws", " gcloud", 1 as any]) {
      await expect(
        applyFederatedGateReplica({ value }, seedCaller),
      ).rejects.toThrow(/invalid federated connector gate value/);
    }
    bay = "seed";
    await expect(
      applyFederatedGateReplica({ value: "gcloud" }, seedCaller),
    ).rejects.toThrow(/doesn't accept gate replication/);
  });
});

describe("the trust-root settings", () => {
  const SIGNER =
    "fake-broker@example-project-1.iam.gserviceaccount.com 109876543210987654321";
  const PIN = "c".repeat(64);
  const seedCaller = {
    cluster_id: "cluster-1",
    bay_id: "seed",
    bay_credential_id: "cred-1",
  };
  const audits = async (action: string) =>
    (
      await q(
        `SELECT * FROM federated_connector_assignment_audit WHERE action=$1 ORDER BY time`,
        [action],
      )
    ).rows;

  it("sets the signer and pins through the audited path, each with its own action", async () => {
    await setFederatedProtectedSettingOnSeed({
      account_id: ADMIN,
      name: "federated_broker_signer",
      value: SIGNER,
    });
    await setFederatedProtectedSettingOnSeed({
      account_id: ADMIN,
      name: "federated_issuer_key_pins",
      value: PIN,
    });
    expect((await audits("broker-signer-change")).at(-1)).toMatchObject({
      actor_account_id: ADMIN,
      before: { signer: null, signer_unique_id: null },
      after: {
        signer: "fake-broker@example-project-1.iam.gserviceaccount.com",
        signer_unique_id: "109876543210987654321",
      },
    });
    expect((await audits("issuer-pin-change")).at(-1)).toMatchObject({
      before: { pins: [] },
      after: { pins: [PIN] },
    });
    expect(propagate).toHaveBeenCalledWith(
      [{ name: "federated_issuer_key_pins", value: PIN }],
      expect.anything(),
    );
  });

  it("refuses an invalid value, an unknown name and a non-admin", async () => {
    await expect(
      setFederatedProtectedSettingOnSeed({
        account_id: ADMIN,
        name: "federated_issuer_key_pins",
        value: "nothex",
      }),
    ).rejects.toThrow(/invalid value/);
    await expect(
      setFederatedProtectedSettingOnSeed({
        account_id: ADMIN,
        name: "site_name",
        value: "x",
      }),
    ).rejects.toThrow(/not a protected/);
    await expect(
      setFederatedProtectedSettingOnSeed({
        account_id: USER,
        name: "federated_broker_signer",
        value: SIGNER,
      }),
    ).rejects.toThrow(/only an admin/);
  });

  it("replicates only canonical values of protected settings from the seed", async () => {
    bay = "attached-a";
    await applyFederatedGateReplica(
      { name: "federated_issuer_key_pins", value: PIN },
      seedCaller,
    );
    for (const [name, value] of [
      ["federated_issuer_key_pins", PIN.toUpperCase()],
      ["federated_broker_signer", "x 1"],
      ["site_name", "x"],
    ]) {
      await expect(
        applyFederatedGateReplica({ name, value }, seedCaller),
      ).rejects.toThrow();
    }
    await expect(
      applyFederatedGateReplica(
        { name: "federated_issuer_key_pins", value: PIN },
        { ...seedCaller, bay_id: "attached-b" },
      ),
    ).rejects.toThrow(/must come from the seed bay/);
  });
});
