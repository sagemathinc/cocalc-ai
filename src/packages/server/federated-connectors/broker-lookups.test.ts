/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import { createBrokerLookupHandler } from "./broker-lookups";

const ID = "109876543210987654321";
const OTHER = "109876543210987654322";
const U = (n: number) => `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const BROKER = { federated_broker_signer_id: ID };
const MINT = {
  site_id: U(1),
  account_id: U(2),
  agent_id: U(3),
  project_id: U(4),
  host_id: U(5),
  run_id: U(6),
  grant_id: U(7),
  lease_id: U(8),
  grant_revision: 1,
};
const ENTRY = {
  provider: "gcp",
  service_account: "reader-sa@example-project-1.iam.gserviceaccount.com",
  permission_profile: "read-only",
  target_project: "example-project-1",
};

function setup(current: string | null = ID, live = true, seed = true) {
  const loadGrant = jest.fn(async () => null);
  const verifyLiveTurn = jest.fn(async () => {
    if (!live) throw Error(`turn ${U(8)} not live: secret detail`);
  });
  const isAllowlisted = jest.fn(async () => true);
  const handle = createBrokerLookupHandler({
    currentSignerId: async () => current ?? undefined,
    loadGrant,
    verifyLiveTurn,
    isAllowlisted,
    isSeedBay: () => seed,
  });
  return { handle, loadGrant, verifyLiveTurn, isAllowlisted };
}

describe("broker lookups on a bay", () => {
  it("answers the broker's three lookups", async () => {
    const t = setup();
    await expect(
      t.handle("loadGrant", [{ account_id: U(2), grant_id: U(7) }], BROKER),
    ).resolves.toBeNull();
    await expect(t.handle("verifyLiveTurn", [MINT], BROKER)).resolves.toEqual({
      live: true,
    });
    await expect(t.handle("isAllowlisted", [ENTRY], BROKER)).resolves.toEqual({
      allowlisted: true,
    });
  });

  it.each([
    ["no caller", undefined],
    ["a bay", { cluster_id: "c", bay_id: "b", bay_credential_id: "k" }],
    ["an account", { account_id: U(2), auth_session_hash: null }],
    ["the broker mixed with a bay", { ...BROKER, bay_id: "b" }],
    ["another signer", { federated_broker_signer_id: OTHER }],
    ["a numeric signer", { federated_broker_signer_id: Number(ID) }],
  ])("refuses %s, doing nothing", async (_n, caller) => {
    const t = setup();
    for (const [method, args] of [
      ["loadGrant", [{ account_id: U(2), grant_id: U(7) }]],
      ["verifyLiveTurn", [MINT]],
      ["isAllowlisted", [ENTRY]],
    ] as const) {
      await expect(t.handle(method, args, caller)).rejects.toThrow(
        "caller_refused",
      );
    }
    expect(t.loadGrant).not.toHaveBeenCalled();
    expect(t.verifyLiveTurn).not.toHaveBeenCalled();
    expect(t.isAllowlisted).not.toHaveBeenCalled();
  });

  it("refuses the broker after a signer rotation, or with no signer recorded", async () => {
    for (const current of [OTHER, null]) {
      const t = setup(current);
      await expect(t.handle("verifyLiveTurn", [MINT], BROKER)).rejects.toThrow(
        "caller_refused",
      );
    }
  });

  it.each([
    ["loadGrant", [{ account_id: U(2) }]],
    ["loadGrant", [{ account_id: U(2), grant_id: "x" }]],
    ["verifyLiveTurn", [{ ...MINT, extra: 1 }]],
    ["isAllowlisted", [{ ...ENTRY, provider: "aws" }]],
    ["isAllowlisted", [{ ...ENTRY, extra: 1 }]],
    ["loadGrant", []],
    ["loadGrant", "x"],
  ])("refuses a malformed %s request", async (method, args) => {
    const t = setup();
    await expect(t.handle(method, args, BROKER)).rejects.toThrow(
      "request_refused",
    );
  });

  it("answers the allowlist only on the seed", async () => {
    const t = setup(ID, true, false);
    await expect(t.handle("isAllowlisted", [ENTRY], BROKER)).rejects.toThrow(
      "not_seed_bay",
    );
    expect(t.isAllowlisted).not.toHaveBeenCalled();
  });

  it("refuses an unknown method, and passes no detail of a failed recheck", async () => {
    const t = setup(ID, false);
    await expect(t.handle("snapshot", [{}], BROKER)).rejects.toThrow(
      "unknown_method",
    );
    const err = await t
      .handle("verifyLiveTurn", [MINT], BROKER)
      .catch((e) => e);
    expect(err.message).toBe("turn_not_live");
  });
});
