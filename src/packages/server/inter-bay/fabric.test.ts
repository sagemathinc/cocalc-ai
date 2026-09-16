/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

jest.mock("@cocalc/backend/data", () => ({
  __esModule: true,
  conatPassword: "default-password",
  conatServer: "http://127.0.0.1:10300",
}));

jest.mock("@cocalc/backend/auth/cookie-names", () => ({
  __esModule: true,
  HUB_PASSWORD_COOKIE_NAME: "hub",
  BAY_CREDENTIAL_COOKIE_NAME: "bay",
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
    credential: process.env.COCALC_BAY_CREDENTIAL,
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_CLUSTER_ROLE;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_SERVER;
    delete process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD;
    delete process.env.COCALC_INTER_BAY_CONAT_SERVER;
    delete process.env.COCALC_INTER_BAY_CONAT_PASSWORD;
    delete process.env.COCALC_BAY_CREDENTIAL;
  });

  afterAll(() => {
    process.env.COCALC_CLUSTER_ROLE = env.role;
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = env.seed_server;
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = env.seed_password;
    process.env.COCALC_INTER_BAY_CONAT_SERVER = env.server;
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = env.password;
    process.env.COCALC_BAY_CREDENTIAL = env.credential;
  });

  it("falls back to the current local conat config", async () => {
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://127.0.0.1:10300",
      cookieName: "hub",
      credential: "default-password",
      bayId: "hub",
    });
  });

  it("uses dedicated fabric env overrides when provided", async () => {
    process.env.COCALC_INTER_BAY_CONAT_SERVER = "http://router-fabric";
    process.env.COCALC_INTER_BAY_CONAT_PASSWORD = "router-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://router-fabric",
      cookieName: "hub",
      credential: "router-secret",
      bayId: "hub",
    });
  });

  it("uses the seed fabric in attached mode", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = "https://seed-fabric";
    process.env.COCALC_BAY_CREDENTIAL = "bay-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "https://seed-fabric",
      cookieName: "bay",
      credential: "bay-secret",
      bayId: "bay-0",
    });
  });

  it("accepts an explicit attached-bay fabric address without the seed alias", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_INTER_BAY_CONAT_SERVER = "https://explicit-fabric";
    process.env.COCALC_BAY_CREDENTIAL = "bay-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "https://explicit-fabric",
      cookieName: "bay",
      credential: "bay-secret",
      bayId: "bay-0",
    });
  });

  it("uses the local fabric and distinct credential in seed mode", async () => {
    process.env.COCALC_CLUSTER_ROLE = "seed";
    process.env.COCALC_BAY_CREDENTIAL = "seed-bay-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(getInterBayFabricConfig()).toEqual({
      address: "http://127.0.0.1:10300",
      cookieName: "bay",
      credential: "seed-bay-secret",
      bayId: "bay-0",
    });
  });

  it("rejects plaintext non-loopback multibay fabric", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = "http://seed-fabric";
    process.env.COCALC_BAY_CREDENTIAL = "bay-secret";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(() => getInterBayFabricConfig()).toThrow(
      "requires HTTPS outside the local loopback",
    );
  });

  it("enables TLS verification for the fabric client", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_CONAT_SERVER = "https://seed-fabric";
    process.env.COCALC_BAY_CREDENTIAL = "bay-secret";
    const { connect } = await import("@cocalc/conat/core/client");
    const { getInterBayFabricClient } = await import("./fabric");
    getInterBayFabricClient();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "https://seed-fabric",
        rejectUnauthorized: true,
      }),
    );
  });

  it("fails fast when an attached bay has no seed fabric config", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { getInterBayFabricConfig } = await import("./fabric");
    expect(() => getInterBayFabricConfig()).toThrow(
      "attached bay requires COCALC_CLUSTER_SEED_CONAT_SERVER",
    );
  });
});
