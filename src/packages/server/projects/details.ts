/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  ProjectRegion,
  ProjectCreated,
  ProjectEnv,
  ProjectCourseInfo,
  ProjectRootfsConfig,
  ProjectRootfsPublishConfig,
  ProjectSnapshotSchedule,
  ProjectBackupSchedule,
  ProjectRunQuota,
} from "@cocalc/conat/hub/api/projects";

export interface ProjectReadDetails {
  region: ProjectRegion;
  created: ProjectCreated;
  env: ProjectEnv;
  rootfs: ProjectRootfsConfig | null;
  rootfs_publish_config: ProjectRootfsPublishConfig | null;
  snapshots: ProjectSnapshotSchedule;
  backups: ProjectBackupSchedule;
  run_quota: ProjectRunQuota;
  course: ProjectCourseInfo;
}

export async function loadProjectReadDetailsDirect(
  project_id: string,
): Promise<ProjectReadDetails | null> {
  const { rows } = await getPool().query<{
    region: ProjectRegion | null;
    created: ProjectCreated | null;
    env: ProjectEnv | null;
    rootfs_image: string | null;
    rootfs_image_id: string | null;
    rootfs_publish_config: ProjectRootfsPublishConfig | null;
    snapshots: ProjectSnapshotSchedule | null;
    backups: ProjectBackupSchedule | null;
    run_quota: ProjectRunQuota | null;
    course: ProjectCourseInfo | null;
  }>(
    `
      SELECT
        region,
        created,
        env,
        rootfs_image,
        rootfs_image_id,
        rootfs_publish_config,
        snapshots,
        backups,
        run_quota,
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
    region: row?.region ?? null,
    created: row?.created ?? null,
    env: row?.env ?? null,
    rootfs: !image
      ? null
      : {
          image,
          ...(image_id ? { image_id } : undefined),
        },
    rootfs_publish_config: row?.rootfs_publish_config ?? null,
    snapshots: row?.snapshots ?? null,
    backups: row?.backups ?? null,
    run_quota: row?.run_quota ?? null,
    course: row?.course ?? null,
  };
}
