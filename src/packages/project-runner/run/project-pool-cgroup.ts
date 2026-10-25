/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The cgroup that every project's cgroup (project-<project_id>) lives under.

export const DEFAULT_PROJECT_POOL_CGROUP = "/sys/fs/cgroup/cocalc-project-pool";

export function projectPoolCgroupPath(): string {
  return (
    process.env.COCALC_PROJECT_POOL_CGROUP?.trim() ||
    DEFAULT_PROJECT_POOL_CGROUP
  );
}
