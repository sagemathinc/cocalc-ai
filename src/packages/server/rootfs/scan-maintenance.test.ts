/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getServerSettingsMock = jest.fn();
const getRoutedHostControlClientMock = jest.fn();
const runRootfsReleaseScanMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: queryMock,
  }),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/rootfs/scan-execution", () => ({
  runRootfsReleaseScan: (...args: any[]) => runRootfsReleaseScanMock(...args),
}));

describe("RootFS scan maintenance", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getServerSettingsMock.mockReset().mockResolvedValue({});
    getRoutedHostControlClientMock.mockReset();
    runRootfsReleaseScanMock.mockReset().mockResolvedValue({ status: "clean" });
  });

  it("selects official visible releases that need weekly rescans", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listDueOfficialRootfsReleasesForScan } =
      await import("./scan-maintenance");

    await listDueOfficialRootfsReleasesForScan({
      olderThanDays: 7,
      limit: 3,
    });

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("COALESCE(img.official, false) = true");
    expect(sql).toContain("COALESCE(img.hidden, false) = false");
    expect(sql).toContain("COALESCE(img.deleted, false) = false");
    expect(sql).toContain("COALESCE(rel.scan_status, 'unknown') <> 'pending'");
    expect(queryMock.mock.calls[0][1]).toEqual([7, 3]);
  });

  it("uses a running cached host for scheduled scans when available", async () => {
    const { runScheduledOfficialRootfsScans } =
      await import("./scan-maintenance");
    const now = new Date();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM rootfs_images AS img")) {
        return {
          rows: [
            {
              release_id: "release-1",
              runtime_image: "cocalc.local/rootfs/release-1",
              image_id: "image-1",
              label: "Standard",
              scanned_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              id: "host-uncached",
              name: "z uncached",
              status: "running",
              last_seen: now,
              deleted: null,
            },
            {
              id: "host-cached",
              name: "a cached",
              status: "running",
              last_seen: now,
              deleted: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    getRoutedHostControlClientMock.mockImplementation(async ({ host_id }) => ({
      listRootfsImages: async () =>
        host_id === "host-cached"
          ? [{ image: "cocalc.local/rootfs/release-1" }]
          : [],
    }));

    const result = await runScheduledOfficialRootfsScans();

    expect(result).toEqual({ scanned: 1, skipped_no_host: 0, failed: 0 });
    expect(runRootfsReleaseScanMock).toHaveBeenCalledWith({
      release_id: "release-1",
      host_id: "host-cached",
      requested_by: null,
    });
  });
});
