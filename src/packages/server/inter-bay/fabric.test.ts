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
    server: process.env.COCALC_INTER_BAY_CONAT_SERVER,
    password: process.env.COCALC_INTER_BAY_CONAT_PASSWORD,
  };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_INTER_BAY_CONAT_SERVER;
    delete process.env.COCALC_INTER_BAY_CONAT_PASSWORD;
  });

  afterAll(() => {
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
});
