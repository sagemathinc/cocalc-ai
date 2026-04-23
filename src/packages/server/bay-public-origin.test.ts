/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;
let listClusterBayRegistryMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("./bay-registry", () => ({
  __esModule: true,
  listClusterBayRegistry: (...args: any[]) =>
    listClusterBayRegistryMock(...args),
}));

describe("bay-public-origin", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock = jest.fn(async () => ({
      dns: "lite4b.cocalc.ai",
    }));
    listClusterBayRegistryMock = jest.fn(async () => []);
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

  it("uses registry DNS when the current attached bay only has local env URLs", async () => {
    process.env.COCALC_BAY_ID = "bay-2";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_BAY_PUBLIC_URL = "http://localhost:13214";
    getServerSettingsMock = jest.fn(async () => ({
      dns: "localhost",
    }));
    listClusterBayRegistryMock = jest.fn(async () => [
      {
        bay_id: "bay-2",
        public_origin: "http://localhost:13214",
        dns_hostname: "bay-2-lite4b.cocalc.ai",
      },
    ]);
    const { getBayPublicOrigin } = await import("./bay-public-origin");
    await expect(getBayPublicOrigin("bay-2")).resolves.toBe(
      "https://bay-2-lite4b.cocalc.ai",
    );
  });

  it("allows browser origins discovered through the bay registry when env bay ids are incomplete", async () => {
    process.env.COCALC_BAY_ID = "bay-2";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    delete process.env.COCALC_CLUSTER_BAY_IDS;
    delete process.env.HUB_CLUSTER_BAY_IDS;
    listClusterBayRegistryMock = jest.fn(async () => [
      {
        bay_id: "bay-0",
        public_origin: "https://lite4b.cocalc.ai",
        dns_hostname: "bay-0-lite4b.cocalc.ai",
      },
      {
        bay_id: "bay-1",
        public_origin: "http://localhost:13114",
        dns_hostname: "bay-1-lite4b.cocalc.ai",
      },
      {
        bay_id: "bay-2",
        public_origin: "http://localhost:13214",
        dns_hostname: "bay-2-lite4b.cocalc.ai",
      },
    ]);
    const { isAllowedBrowserOrigin } = await import("./bay-public-origin");
    await expect(
      isAllowedBrowserOrigin("https://bay-1-lite4b.cocalc.ai"),
    ).resolves.toBe(true);
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

  it("derives the stable site origin from an attached bay request when site dns is unavailable locally", async () => {
    getServerSettingsMock = jest.fn(async () => ({}));
    process.env.COCALC_BAY_ID = "bay-2";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { getSitePublicOriginForRequest } =
      await import("./bay-public-origin");
    await expect(
      getSitePublicOriginForRequest({
        headers: {
          host: "bay-2-lite4b.cocalc.ai",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
        secure: true,
      } as any),
    ).resolves.toBe("https://lite4b.cocalc.ai");
  });

  it("derives the shared cookie domain from an attached bay request when site dns is unavailable locally", async () => {
    getServerSettingsMock = jest.fn(async () => ({}));
    process.env.COCALC_BAY_ID = "bay-2";
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { getBrowserCookieDomainForRequest } =
      await import("./bay-public-origin");
    await expect(
      getBrowserCookieDomainForRequest({
        headers: {
          host: "bay-2-lite4b.cocalc.ai",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
        secure: true,
      } as any),
    ).resolves.toBe("cocalc.ai");
  });
});
