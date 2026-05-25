/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

export const ROOTFS_RUSTIC_SHARED_REPO_ROOT_PREFIX = "rustic/rootfs-images";
export const ROOTFS_RUSTIC_REPO_STATUS_ACTIVE = "active";
export const ROOTFS_RUSTIC_REPO_STATUS_SEALED = "sealed";
export const ROOTFS_RUSTIC_REPO_STATUS_DRAINING = "draining";
export const ROOTFS_RUSTIC_REPO_STATUS_DISABLED = "disabled";
export const ROOTFS_RUSTIC_ACTIVE_SHARDS_PER_REGION = 4;
export const ROOTFS_RUSTIC_RELEASES_PER_SHARD = 1000;

let rootfsRusticRepoSchemaReady: Promise<void> | undefined;

export async function ensureRootfsRusticRepoSchema(): Promise<void> {
  if (!rootfsRusticRepoSchemaReady) {
    rootfsRusticRepoSchemaReady = (async () => {
      const pool = getPool("medium");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rootfs_rustic_repos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          region TEXT NOT NULL,
          bucket_id UUID NOT NULL,
          root TEXT NOT NULL,
          secret TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '${ROOTFS_RUSTIC_REPO_STATUS_ACTIVE}',
          created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (status IN ('${ROOTFS_RUSTIC_REPO_STATUS_ACTIVE}', '${ROOTFS_RUSTIC_REPO_STATUS_SEALED}', '${ROOTFS_RUSTIC_REPO_STATUS_DRAINING}', '${ROOTFS_RUSTIC_REPO_STATUS_DISABLED}'))
        )
      `);
      await pool.query(
        "ALTER TABLE rootfs_releases ADD COLUMN IF NOT EXISTS repo_id UUID",
      );
      await pool.query(
        "ALTER TABLE rootfs_release_artifacts ADD COLUMN IF NOT EXISTS repo_id UUID",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS rootfs_rustic_repos_region_idx ON rootfs_rustic_repos(region)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS rootfs_rustic_repos_status_idx ON rootfs_rustic_repos(status)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS rootfs_rustic_repos_bucket_idx ON rootfs_rustic_repos(bucket_id)",
      );
      await pool.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS rootfs_rustic_repos_bucket_root_idx ON rootfs_rustic_repos(bucket_id, root)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS rootfs_releases_repo_id_idx ON rootfs_releases(repo_id)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS rootfs_release_artifacts_repo_id_idx ON rootfs_release_artifacts(repo_id)",
      );
    })().catch((err) => {
      rootfsRusticRepoSchemaReady = undefined;
      throw err;
    });
  }
  await rootfsRusticRepoSchemaReady;
}
