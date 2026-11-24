/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const setServerSetting = jest.fn(({ cb }) => cb());
jest.mock("@cocalc/database", () => ({
  db: () => ({ set_server_setting: setServerSetting }),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));

import { applyServerSettingFromBay } from "./server-setting-replica";

const seedOnly = (name: string) => name === "stripe_secret_key";

beforeEach(() => setServerSetting.mockClear());

describe("generic BayOps setServerSetting", () => {
  it.each([
    ["attached-a", "federated_cli_connectors"],
    ["seed", "federated_cli_connectors"],
    ["attached-a", "federated_broker_signer"],
    ["attached-a", "federated_issuer_key_pins"],
  ])("refuses a protected federated setting on %s (%s)", async (bay, name) => {
    await expect(
      applyServerSettingFromBay(bay, { name, value: "x" }, seedOnly),
    ).rejects.toThrow(/replicated only from the seed/);
    expect(setServerSetting).not.toHaveBeenCalled();
  });

  it("still applies ordinary settings and refuses seed-only ones off the seed", async () => {
    await applyServerSettingFromBay(
      "attached-a",
      { name: "site_name", value: "x" },
      seedOnly,
    );
    expect(setServerSetting).toHaveBeenCalledTimes(1);
    await expect(
      applyServerSettingFromBay(
        "attached-a",
        { name: "stripe_secret_key", value: "x" },
        seedOnly,
      ),
    ).rejects.toThrow(/seed-only/);
  });
});
