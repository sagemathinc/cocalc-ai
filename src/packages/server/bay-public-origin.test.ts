/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

describe("bay-public-origin", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({
      dns: "lite4b.cocalc.ai",
    }));
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "bay-0";
    delete process.env.COCALC_BAY_PUBLIC_URL;
    delete process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS;
    delete process.env.HUB_CLUSTER_BAY_PUBLIC_URLS;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("returns the stable site origin for the seed bay", async () => {
    process.env.COCALC_BAY_PUBLIC_URL = "http://localhost:9100";
    process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS =
      "bay-0=http://localhost:9100,bay-1=http://localhost:13114";
    const { getBayPublicOrigin } = await import("./bay-public-origin");
    await expect(getBayPublicOrigin("bay-0")).resolves.toBe(
      "https://lite4b.cocalc.ai",
    );
  });

  it("ignores localhost bay URL overrides and derives attached bay hostnames from site dns", async () => {
    process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS = "bay-1=http://localhost:13114";
    const { getBayPublicOrigin } = await import("./bay-public-origin");
    await expect(getBayPublicOrigin("bay-1")).resolves.toBe(
      "https://bay-1-lite4b.cocalc.ai",
    );
  });

  it("uses an explicit non-local public bay override when provided", async () => {
    process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS =
      "bay-1=https://bay-1-alt.example.com";
    const { getBayPublicOrigin } = await import("./bay-public-origin");
    await expect(getBayPublicOrigin("bay-1")).resolves.toBe(
      "https://bay-1-alt.example.com",
    );
  });

  it("derives a remote bay origin from the current request origin when site dns is unavailable locally", async () => {
    getServerSettingsMock = jest.fn(async () => ({}));
    process.env.COCALC_BAY_ID = "bay-1";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { getBayPublicOriginForRequest } =
      await import("./bay-public-origin");
    await expect(
      getBayPublicOriginForRequest(
        {
          headers: {
            host: "bay-1-lite4b.cocalc.ai",
            "x-forwarded-proto": "https",
          },
          protocol: "https",
          secure: true,
        } as any,
        "bay-2",
      ),
    ).resolves.toBe("https://bay-2-lite4b.cocalc.ai");
  });
});
