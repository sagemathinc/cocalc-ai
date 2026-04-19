/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type HostRuntimeRetentionPolicy } from "@cocalc/conat/project-host/api";
import { DEFAULT_RUNTIME_RETENTION_POLICY } from "../../../conat/project-host/retention-policy";

export function defaultHostRuntimeRetentionPolicy(): HostRuntimeRetentionPolicy {
  return {
    "project-host": {
      keep_count: DEFAULT_RUNTIME_RETENTION_POLICY["project-host"].keep_count,
    },
    "project-bundle": {
      keep_count: DEFAULT_RUNTIME_RETENTION_POLICY["project-bundle"].keep_count,
    },
    tools: {
      keep_count: DEFAULT_RUNTIME_RETENTION_POLICY.tools.keep_count,
    },
  };
}
