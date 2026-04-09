/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  ProjectLauncherSettings,
  ProjectRegion,
  ProjectCreated,
  ProjectEnv,
  ProjectCourseInfo,
  ProjectRootfsConfig,
  ProjectQuotaSettings,
  ProjectSnapshotSchedule,
  ProjectBackupSchedule,
  ProjectRunQuota,
} from "@cocalc/conat/hub/api/projects";

export interface ProjectReadDetails {
  launcher: ProjectLauncherSettings;
  region: ProjectRegion;
  created: ProjectCreated;
  env: ProjectEnv;
  rootfs: ProjectRootfsConfig | null;
  snapshots: ProjectSnapshotSchedule;
  backups: ProjectBackupSchedule;
  run_quota: ProjectRunQuota;
  settings: ProjectQuotaSettings;
  course: ProjectCourseInfo;
}

export async function loadProjectReadDetailsDirect(
  project_id: string,
): Promise<ProjectReadDetails | null> {
  const { rows } = await getPool().query<{
    launcher: ProjectLauncherSettings | null;
    region: ProjectRegion | null;
    created: ProjectCreated | null;
    env: ProjectEnv | null;
    rootfs_image: string | null;
    rootfs_image_id: string | null;
    snapshots: ProjectSnapshotSchedule | null;
    backups: ProjectBackupSchedule | null;
    run_quota: ProjectRunQuota | null;
    settings: ProjectQuotaSettings | null;
    course: ProjectCourseInfo | null;
  }>(
    `
      SELECT
        launcher,
        region,
        created,
        env,
        rootfs_image,
        rootfs_image_id,
        snapshots,
        backups,
        run_quota,
        settings,
        course
      FROM projects
      WHERE project_id = $1
      LIMIT 1
    `,
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const image = `${row?.rootfs_image ?? ""}`.trim();
  const image_id = `${row?.rootfs_image_id ?? ""}`.trim();
  return {
    launcher: row?.launcher ?? null,
    region: row?.region ?? null,
    created: row?.created ?? null,
    env: row?.env ?? null,
    rootfs: !image
      ? null
      : {
          image,
          ...(image_id ? { image_id } : undefined),
        },
    snapshots: row?.snapshots ?? null,
    backups: row?.backups ?? null,
    run_quota: row?.run_quota ?? null,
    settings: row?.settings ?? null,
    course: row?.course ?? null,
  };
}
