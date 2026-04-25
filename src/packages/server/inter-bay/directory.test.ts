/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const requestMock = jest.fn();
const queryMock = jest.fn();
const directoryResolveProjectBayMock = jest.fn();
const directoryResolveHostBayMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  __esModule: true,
  getInterBayFabricClient: jest.fn(() => ({
    request: (...args: any[]) => requestMock(...args),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    directory: jest.fn(() => ({
      resolveProjectBay: (...args: any[]) =>
        directoryResolveProjectBayMock(...args),
      resolveHostBay: (...args: any[]) => directoryResolveHostBayMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  __esModule: true,
  getConfiguredClusterBayIdsForStaticEnumerationOnly: jest.fn(() => [
    "bay-0",
    "bay-1",
    "bay-2",
  ]),
}));

describe("inter-bay directory", () => {
  beforeEach(() => {
    jest.resetModules();
    requestMock.mockReset();
    queryMock.mockReset();
    directoryResolveProjectBayMock.mockReset();
    directoryResolveHostBayMock.mockReset();
    delete process.env.COCALC_BAY_ID;
  });

  it("resolves project ownership through the directory rpc subject", async () => {
    requestMock.mockResolvedValue({ data: { bay_id: "bay-0", epoch: 0 } });
    const { resolveProjectBay } = await import("./directory");
    await expect(resolveProjectBay("proj-1")).resolves.toEqual({
      bay_id: "bay-0",
      epoch: 0,
    });
    expect(requestMock).toHaveBeenCalledWith(
      "global.directory.rpc.resolve-project-bay",
      {
        name: "resolveProjectBay",
        args: [{ project_id: "proj-1" }],
      },
      { timeout: 10 * 1000, waitForInterest: true },
    );
  });

  it("queries the local database for direct project resolution", async () => {
    queryMock.mockResolvedValue({ rows: [{ bay_id: "bay-7" }] });
    const { resolveProjectBayDirect } = await import("./directory");
    await expect(resolveProjectBayDirect("proj-1")).resolves.toEqual({
      bay_id: "bay-7",
      epoch: 0,
    });
    expect(queryMock).toHaveBeenCalled();
  });

  it("falls back across configured bays for project resolution", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    directoryResolveProjectBayMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bay_id: "bay-2", epoch: 0 });
    const { resolveProjectBayAcrossCluster } = await import("./directory");
    await expect(resolveProjectBayAcrossCluster("proj-1")).resolves.toEqual({
      bay_id: "bay-2",
      epoch: 0,
    });
  });

  it("falls back across configured bays for host resolution", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    directoryResolveHostBayMock.mockResolvedValueOnce({
      bay_id: "bay-1",
      epoch: 0,
    });
    const { resolveHostBayAcrossCluster } = await import("./directory");
    await expect(resolveHostBayAcrossCluster("host-1")).resolves.toEqual({
      bay_id: "bay-1",
      epoch: 0,
    });
  });

  it("can resolve deleted hosts directly when requested", async () => {
    queryMock.mockResolvedValue({ rows: [{ bay_id: "bay-9" }] });
    const { resolveHostBayDirect } = await import("./directory");
    await expect(
      resolveHostBayDirect("host-1", { include_deleted: true }),
    ).resolves.toEqual({
      bay_id: "bay-9",
      epoch: 0,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1"),
      ["host-1", "bay-0"],
    );
    expect(queryMock.mock.calls[0][0]).not.toContain("AND deleted IS NULL");
  });

  it("surfaces service-side directory errors", async () => {
    requestMock.mockResolvedValue({ data: { error: "boom" } });
    const { resolveHostBay } = await import("./directory");
    await expect(resolveHostBay("host-1")).rejects.toThrow("boom");
  });
});
