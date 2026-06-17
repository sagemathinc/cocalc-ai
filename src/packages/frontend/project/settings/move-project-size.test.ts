/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { loadProjectMoveSizeBytes } from "./move-project-size";
import getStorageHistory from "@cocalc/frontend/project/disk-usage/storage-history";
import getStorageOverview from "@cocalc/frontend/project/disk-usage/storage-overview";

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: (project_id: string) => `/projects/${project_id}`,
}));

jest.mock("@cocalc/frontend/project/disk-usage/storage-overview", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/disk-usage/storage-history", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const getStorageOverviewMock = getStorageOverview as jest.Mock;
const getStorageHistoryMock = getStorageHistory as jest.Mock;

describe("loadProjectMoveSizeBytes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses project quota usage from the storage overview", async () => {
    getStorageOverviewMock.mockResolvedValueOnce({
      quotas: [
        { key: "project", label: "Project quota", used: 396, size: 1000 },
      ],
    });

    await expect(
      loadProjectMoveSizeBytes({ project_id: "project-1" }),
    ).resolves.toBe(396);

    expect(getStorageOverviewMock).toHaveBeenCalledWith({
      project_id: "project-1",
      home: "/projects/project-1",
      cache: true,
    });
    expect(getStorageHistoryMock).not.toHaveBeenCalled();
  });

  it("falls back to the newest persisted quota history point", async () => {
    getStorageOverviewMock.mockRejectedValueOnce(new Error("offline"));
    getStorageHistoryMock.mockResolvedValueOnce({
      points: [
        { quota_used_bytes: 111 },
        { quota_used_bytes: undefined },
        { quota_used_bytes: 222 },
      ],
    });

    await expect(
      loadProjectMoveSizeBytes({ project_id: "project-1" }),
    ).resolves.toBe(222);
  });

  it("returns undefined when neither quota source is available", async () => {
    getStorageOverviewMock.mockResolvedValueOnce({ quotas: [] });
    getStorageHistoryMock.mockResolvedValueOnce({ points: [] });

    await expect(
      loadProjectMoveSizeBytes({ project_id: "project-1" }),
    ).resolves.toBeUndefined();
  });
});
