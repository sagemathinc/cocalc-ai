/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { humanSize } from "@cocalc/util/misc";

export const PROJECT_DISK_QUOTA_EXCEEDED_CODE = "project_disk_quota_exceeded";

type ProjectQuota = {
  size: number;
  used: number;
};

type Logger = {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
};

export class ProjectDiskQuotaExceededError extends Error {
  public readonly code = PROJECT_DISK_QUOTA_EXCEEDED_CODE;
  public readonly quota_used_bytes: number;
  public readonly quota_size_bytes: number;

  constructor({ used, size }: ProjectQuota) {
    super(
      `Project disk quota exceeded: this project is using ${humanSize(used)} of ${humanSize(size)}, so it cannot be started. You do not need to start the project to browse, edit, download, or delete files and snapshots. Delete files, delete snapshots, upgrade your membership for more project disk space, or contact support.`,
    );
    this.name = "ProjectDiskQuotaExceededError";
    this.quota_used_bytes = used;
    this.quota_size_bytes = size;
  }
}

export function isProjectDiskQuotaExceeded(quota: ProjectQuota): boolean {
  const used = Number(quota.used);
  const size = Number(quota.size);
  return (
    Number.isFinite(used) && Number.isFinite(size) && size > 0 && used >= size
  );
}

export async function assertProjectDiskQuotaStartAllowed({
  project_id,
  getQuota,
  logger,
}: {
  project_id: string;
  getQuota: (project_id: string) => Promise<ProjectQuota>;
  logger: Logger;
}): Promise<void> {
  let quota: ProjectQuota;
  try {
    quota = await getQuota(project_id);
  } catch (err) {
    logger.warn("unable to check project disk quota before start", {
      project_id,
      err: `${err}`,
    });
    return;
  }
  if (isProjectDiskQuotaExceeded(quota)) {
    throw new ProjectDiskQuotaExceededError(quota);
  }
}
