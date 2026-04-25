/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let connectMock: jest.Mock;
let poolQueryMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let getServerProviderMock: jest.Mock;
let listServerProvidersMock: jest.Mock;
let loggerFactoryMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: (...args: any[]) => loggerFactoryMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    connect: connectMock,
    query: poolQueryMock,
  })),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("./providers", () => ({
  __esModule: true,
  getServerProvider: (...args: any[]) => getServerProviderMock(...args),
  listServerProviders: (...args: any[]) => listServerProvidersMock(...args),
}));

describe("refreshCloudCatalogNow", () => {
  const fetchCatalogMock = jest.fn();
  const toEntriesMock = jest.fn();
  const clientQueryMock = jest.fn();
  const releaseMock = jest.fn();
  const provider = {
    id: "gcp",
    entry: {
      id: "gcp",
      fetchCatalog: (...args: any[]) => fetchCatalogMock(...args),
      catalog: {
        ttlSeconds: { regions: 3600 },
        toEntries: (...args: any[]) => toEntriesMock(...args),
      },
    },
  };

  beforeEach(() => {
    jest.resetModules();
    fetchCatalogMock.mockReset();
    toEntriesMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock = jest.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    }));
    poolQueryMock = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    getServerSettingsMock = jest.fn(async () => ({}));
    getServerProviderMock = jest.fn(() => provider);
    listServerProvidersMock = jest.fn(() => [provider]);
    loggerFactoryMock = jest.fn(() => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    }));
    fetchCatalogMock.mockResolvedValue({ regions: ["us-central1"] });
    toEntriesMock.mockReturnValue([
      {
        kind: "regions",
        scope: "global",
        payload: [{ name: "us-central1" }],
      },
    ]);
  });

  it("waits for the provider lock when requested and refreshes the catalog", async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    const { refreshCloudCatalogNow } = await import("./catalog");
    await refreshCloudCatalogNow({ provider: "gcp" as any, wait: true });

    expect(clientQueryMock).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_lock(hashtext($1))",
      ["cloud_catalog_refresh:gcp"],
    );
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO cloud_catalog_cache"),
      expect.arrayContaining(["gcp", "regions", "global"]),
    );
    expect(clientQueryMock).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock(hashtext($1))",
      ["cloud_catalog_refresh:gcp"],
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when a non-blocking refresh sees the lock already held", async () => {
    clientQueryMock.mockResolvedValueOnce({ rows: [{ locked: false }] });

    const { refreshCloudCatalogNow } = await import("./catalog");
    await refreshCloudCatalogNow({ provider: "gcp" as any });

    expect(clientQueryMock).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      ["cloud_catalog_refresh:gcp"],
    );
    expect(fetchCatalogMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(clientQueryMock).toHaveBeenCalledTimes(1);
  });
});
