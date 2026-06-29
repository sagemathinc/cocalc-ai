/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  PROJECT_DISK_QUOTA_EXCEEDED_CODE,
  ProjectDiskQuotaExceededError,
  assertProjectDiskQuotaStartAllowed,
  isProjectDiskQuotaExceeded,
} from "./project-start-quota";

describe("project start quota admission", () => {
  it("detects quota usage at or above the project limit", () => {
    expect(isProjectDiskQuotaExceeded({ used: 9, size: 10 })).toBe(false);
    expect(isProjectDiskQuotaExceeded({ used: 10, size: 10 })).toBe(true);
    expect(isProjectDiskQuotaExceeded({ used: 11, size: 10 })).toBe(true);
    expect(isProjectDiskQuotaExceeded({ used: 11, size: 0 })).toBe(false);
  });

  it("throws a stable coded error when the project is over quota", async () => {
    await expect(
      assertProjectDiskQuotaStartAllowed({
        project_id: "project-1",
        getQuota: async () => ({ used: 9_100_000_000, size: 4_000_000_000 }),
        logger: { warn: jest.fn() },
      }),
    ).rejects.toMatchObject({
      code: PROJECT_DISK_QUOTA_EXCEEDED_CODE,
      quota_used_bytes: 9_100_000_000,
      quota_size_bytes: 4_000_000_000,
    });
  });

  it("uses actionable wording in the over-quota error", () => {
    const err = new ProjectDiskQuotaExceededError({
      used: 9_100_000_000,
      size: 4_000_000_000,
    });
    expect(err.message).toContain("Project disk quota exceeded");
    expect(err.message).toContain("cannot be started");
    expect(err.message).toContain("do not need to start the project");
    expect(err.message).toContain("browse, edit, download, or delete files");
    expect(err.message).toContain("Delete files");
    expect(err.message).toContain("upgrade your membership");
    expect(err.message).toContain("contact support");
  });

  it("logs and allows start to continue if quota inspection fails", async () => {
    const warn = jest.fn();
    await expect(
      assertProjectDiskQuotaStartAllowed({
        project_id: "project-1",
        getQuota: async () => {
          throw new Error("quota unavailable");
        },
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "unable to check project disk quota before start",
      expect.objectContaining({
        project_id: "project-1",
        err: "Error: quota unavailable",
      }),
    );
  });
});
