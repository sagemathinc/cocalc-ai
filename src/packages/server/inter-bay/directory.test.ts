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

  it("uses direct local project resolution before directory rpc", async () => {
    queryMock.mockResolvedValue({ rows: [{ bay_id: "bay-local" }] });
    const { resolveProjectBay } = await import("./directory");
    await expect(resolveProjectBay("proj-1")).resolves.toEqual({
      bay_id: "bay-local",
      epoch: 0,
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("resolves project ownership through the directory rpc subject on a local miss", async () => {
    queryMock.mockResolvedValue({ rows: [] });
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

  it("uses direct local host resolution before directory rpc", async () => {
    queryMock.mockResolvedValue({ rows: [{ bay_id: "bay-local" }] });
    const { resolveHostBay } = await import("./directory");
    await expect(resolveHostBay("host-1")).resolves.toEqual({
      bay_id: "bay-local",
      epoch: 0,
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("resolves host ownership through the directory rpc subject on a local miss", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    requestMock.mockResolvedValue({ data: { bay_id: "bay-0", epoch: 0 } });
    const { resolveHostBay } = await import("./directory");
    await expect(resolveHostBay("host-1")).resolves.toEqual({
      bay_id: "bay-0",
      epoch: 0,
    });
    expect(requestMock).toHaveBeenCalledWith(
      "global.directory.rpc.resolve-host-bay",
      {
        name: "resolveHostBay",
        args: [{ host_id: "host-1", include_deleted: false }],
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

  it("resolves a batch of local projects with one database query", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { project_id: "proj-1", bay_id: "bay-1" },
        { project_id: "proj-2", bay_id: "bay-2" },
      ],
    });
    const { resolveProjectBays } = await import("./directory");
    await expect(
      resolveProjectBays(["proj-1", "proj-2", "proj-1"]),
    ).resolves.toEqual(
      new Map([
        ["proj-1", { bay_id: "bay-1", epoch: 0 }],
        ["proj-2", { bay_id: "bay-2", epoch: 0 }],
      ]),
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("uses directory fallback only for projects missing locally", async () => {
    queryMock.mockResolvedValue({
      rows: [{ project_id: "proj-1", bay_id: "bay-1" }],
    });
    requestMock.mockResolvedValue({ data: { bay_id: "bay-remote", epoch: 7 } });
    const { resolveProjectBays } = await import("./directory");
    await expect(resolveProjectBays(["proj-1", "proj-2"])).resolves.toEqual(
      new Map([
        ["proj-1", { bay_id: "bay-1", epoch: 0 }],
        ["proj-2", { bay_id: "bay-remote", epoch: 7 }],
      ]),
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("with a deadline, gives directory lookups only the time left", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    requestMock.mockResolvedValue({ data: { bay_id: "bay-remote", epoch: 7 } });
    const { resolveProjectBays } = await import("./directory");
    const deadline = Date.now() + 3_000;
    await expect(resolveProjectBays(["proj-2"], { deadline })).resolves.toEqual(
      new Map([["proj-2", { bay_id: "bay-remote", epoch: 7 }]]),
    );
    const { timeout } = requestMock.mock.calls[0][2];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(3_000);
  });

  it("with a deadline, leaves out a project not resolved in time", async () => {
    queryMock.mockResolvedValue({
      rows: [{ project_id: "proj-1", bay_id: "bay-1" }],
    });
    requestMock.mockRejectedValue(new Error("timeout"));
    const { resolveProjectBays } = await import("./directory");
    await expect(
      resolveProjectBays(["proj-1", "proj-2"], {
        deadline: Date.now() + 1_000,
      }),
    ).resolves.toEqual(new Map([["proj-1", { bay_id: "bay-1", epoch: 0 }]]));
  });

  it("with a deadline already past, asks the directory nothing", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { getInterBayFabricClient } =
      await import("@cocalc/server/inter-bay/fabric");
    (getInterBayFabricClient as jest.Mock).mockClear();
    const { resolveProjectBays } = await import("./directory");
    await expect(
      resolveProjectBays(["proj-2"], { deadline: Date.now() - 1 }),
    ).resolves.toEqual(new Map());
    expect(requestMock).not.toHaveBeenCalled();
    expect(getInterBayFabricClient).not.toHaveBeenCalled();
  });

  it("with a deadline, a missing fabric client leaves projects unresolved", async () => {
    queryMock.mockResolvedValue({
      rows: [{ project_id: "proj-1", bay_id: "bay-1" }],
    });
    const { getInterBayFabricClient } =
      await import("@cocalc/server/inter-bay/fabric");
    (getInterBayFabricClient as jest.Mock).mockImplementationOnce(() => {
      throw new Error("missing inter-bay Conat credential");
    });
    const { resolveProjectBays } = await import("./directory");
    await expect(
      resolveProjectBays(["proj-1", "proj-2"], {
        deadline: Date.now() + 1_000,
      }),
    ).resolves.toEqual(new Map([["proj-1", { bay_id: "bay-1", epoch: 0 }]]));
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
    queryMock.mockResolvedValue({ rows: [] });
    requestMock.mockResolvedValue({ data: { error: "boom" } });
    const { resolveHostBay } = await import("./directory");
    await expect(resolveHostBay("host-1")).rejects.toThrow("boom");
  });
});
