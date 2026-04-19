/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  HostInstalledRuntimeArtifact,
  HostRuntimeArtifactRetentionPolicy,
} from "./api";

export const DEFAULT_RUNTIME_RETENTION_POLICY: Record<
  HostInstalledRuntimeArtifact,
  HostRuntimeArtifactRetentionPolicy
> = Object.freeze({
  "project-host": { keep_count: 10 },
  "project-bundle": { keep_count: 3 },
  tools: { keep_count: 3 },
});
