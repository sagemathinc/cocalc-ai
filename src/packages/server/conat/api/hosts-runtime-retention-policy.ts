/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  DEFAULT_RUNTIME_RETENTION_POLICY,
  type HostRuntimeRetentionPolicy,
} from "@cocalc/conat/project-host/api";

function parseNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  const text = `${raw ?? ""}`.trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function normalizeHostRuntimeRetentionPolicy(
  raw?: unknown,
): HostRuntimeRetentionPolicy {
  const configured =
    raw != null && typeof raw === "object" ? (raw as Record<string, any>) : {};
  return {
    "project-host": {
      keep_count:
        parseNonNegativeInt(configured["project-host"]?.keep_count) ??
        DEFAULT_RUNTIME_RETENTION_POLICY["project-host"].keep_count,
      ...(parseNonNegativeInt(configured["project-host"]?.max_bytes) != null
        ? {
            max_bytes: parseNonNegativeInt(
              configured["project-host"]?.max_bytes,
            ),
          }
        : {}),
    },
    "project-bundle": {
      keep_count:
        parseNonNegativeInt(configured["project-bundle"]?.keep_count) ??
        DEFAULT_RUNTIME_RETENTION_POLICY["project-bundle"].keep_count,
      ...(parseNonNegativeInt(configured["project-bundle"]?.max_bytes) != null
        ? {
            max_bytes: parseNonNegativeInt(
              configured["project-bundle"]?.max_bytes,
            ),
          }
        : {}),
    },
    tools: {
      keep_count:
        parseNonNegativeInt(configured.tools?.keep_count) ??
        DEFAULT_RUNTIME_RETENTION_POLICY.tools.keep_count,
      ...(parseNonNegativeInt(configured.tools?.max_bytes) != null
        ? {
            max_bytes: parseNonNegativeInt(configured.tools?.max_bytes),
          }
        : {}),
    },
  };
}

export async function defaultHostRuntimeRetentionPolicy(): Promise<HostRuntimeRetentionPolicy> {
  const settings = await getServerSettings();
  return normalizeHostRuntimeRetentionPolicy(
    settings.project_hosts_runtime_retention_policy,
  );
}
