/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  conatPassword: "default-password",
  conatServer: "http://default-fabric",
}));

jest.mock("@cocalc/backend/auth/cookie-names", () => ({
  __esModule: true,
  HUB_PASSWORD_COOKIE_NAME: "hub",
}));

jest.mock("@cocalc/conat/core/client", () => ({
  __esModule: true,
  connect: jest.fn(),
}));

describe("inter-bay fabric config", () => {
  const env = {
    role: process.env.COCALC_CLUSTER_ROLE,
    seed_server: process.env.COCALC_CLUSTER_SEED_CONAT_SERVER,
    seed_password: process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD,
    server: process.env.COCALC_INTER_BAY_CONAT_SERVER,
    password: process.env.COCALC_INTER_BAY_CONAT_PASSWORD,
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_CLUSTER_ROLE;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_SERVER;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD;
    delete process.env.COCALC_INTER_BAY_CONAT_SERVER;
    delete process.env.COCALC_INTER_BAY_CONAT_PASSWORD;
  });

  afterAll(() => {
    process.env.COCALC_CLUSTER_ROLE = env.role;
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = env.seed_server;
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = env.seed_password;
    process.env.COCALC_INTER_BAY_CONAT_SERVER = env.server;
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = env.password;
  });

  it("falls back to the current local conat config", async () => {
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://default-fabric",
      password: "default-password",
    });
  });

  it("uses dedicated fabric env overrides when provided", async () => {
    process.env.COCALC_INTER_BAY_CONAT_SERVER = "http://router-fabric";
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = "router-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://router-fabric",
      password: "router-secret",
    });
  });

  it("uses the seed fabric in attached mode", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = "http://seed-fabric";
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = "seed-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://seed-fabric",
      password: "seed-secret",
    });
  });

  it("fails fast when an attached bay has no seed fabric config", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(() => getInterBayFabricConfig()).toThrow(
      "attached bay requires COCALC_CLUSTER_SEED_CONAT_SERVER",
    );
  });
});
