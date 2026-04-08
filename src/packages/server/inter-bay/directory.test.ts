/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const requestMock = jest.fn();
const queryMock = jest.fn();

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({
    request: (...args: any[]) => requestMock(...args),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

describe("inter-bay directory", () => {
  beforeEach(() => {
    jest.resetModules();
    requestMock.mockReset();
    queryMock.mockReset();
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
      { project_id: "proj-1" },
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

  it("surfaces service-side directory errors", async () => {
    requestMock.mockResolvedValue({ data: { error: "boom" } });
    const { resolveHostBay } = await import("./directory");
    await expect(resolveHostBay("host-1")).rejects.toThrow("boom");
  });
});
