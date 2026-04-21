/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

describe("cluster-config", () => {
  const env = {
    bay_id: process.env.COCALC_BAY_ID,
    cluster_bay_ids: process.env.HUB_CLUSTER_BAY_IDS,
    cluster_role: process.env.COCALC_CLUSTER_ROLE,
    seed_bay_id: process.env.COCALC_CLUSTER_SEED_BAY_ID,
    seed_server: process.env.COCALC_CLUSTER_SEED_CONAT_SERVER,
    seed_password: process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD,
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_BAY_ID;
    delete process.env.HUB_CLUSTER_BAY_IDS;
    delete process.env.COCALC_CLUSTER_ROLE;
    delete process.env.COCALC_CLUSTER_SEED_BAY_ID;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_SERVER;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD;
  });

  afterAll(() => {
    process.env.COCALC_BAY_ID = env.bay_id;
    process.env.HUB_CLUSTER_BAY_IDS = env.cluster_bay_ids;
    process.env.COCALC_CLUSTER_ROLE = env.cluster_role;
    process.env.COCALC_CLUSTER_SEED_BAY_ID = env.seed_bay_id;
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = env.seed_server;
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = env.seed_password;
  });

  it("defaults to standalone with the local bay as seed", async () => {
    const { getClusterConfig, isMultiBayCluster } =
      await import("./cluster-config");
    expect(getClusterConfig()).toEqual({
      role: "standalone",
      seed_bay_id: "bay-0",
      seed_conat_server: undefined,
      seed_conat_password: undefined,
    });
    expect(isMultiBayCluster()).toBe(false);
  });

  it("uses the current bay as the seed in seed mode by default", async () => {
    process.env.COCALC_BAY_ID = "bay-primary";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    const { getClusterConfig, isMultiBayCluster } =
      await import("./cluster-config");
    expect(getClusterConfig()).toEqual({
      role: "seed",
      seed_bay_id: "bay-primary",
      seed_conat_server: undefined,
      seed_conat_password: undefined,
    });
    expect(isMultiBayCluster()).toBe(true);
  });

  it("uses explicit seed config for an attached bay", async () => {
    process.env.COCALC_BAY_ID = "bay-7";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "bay-seed";
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = "http://seed-fabric";
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = "seed-secret";
    const { getClusterConfig } = await import("./cluster-config");
    expect(getClusterConfig()).toEqual({
      role: "attached",
      seed_bay_id: "bay-seed",
      seed_conat_server: "http://seed-fabric",
      seed_conat_password: "seed-secret",
    });
  });

  it("rejects an invalid cluster role", async () => {
    process.env.COCALC_CLUSTER_ROLE = "weird";
    const { getConfiguredClusterRole } = await import("./cluster-config");
    expect(() => getConfiguredClusterRole()).toThrow(
      "invalid COCALC_CLUSTER_ROLE",
    );
  });

  it("parses configured cluster bay ids from the daemon env", async () => {
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.HUB_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    const { getConfiguredClusterBayIdsForStaticEnumerationOnly } =
      await import("./cluster-config");
    expect(getConfiguredClusterBayIdsForStaticEnumerationOnly()).toEqual([
      "bay-0",
      "bay-1",
      "bay-2",
    ]);
  });
});
