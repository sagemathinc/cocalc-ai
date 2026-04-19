/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import path from "node:path";
import type {
  HostInstalledRuntimeArtifact,
  HostRuntimeArtifactRetentionPolicy,
  HostRuntimeRetentionPolicy,
} from "@cocalc/conat/project-host/api";
import { DEFAULT_RUNTIME_RETENTION_POLICY } from "@cocalc/conat/project-host/api";

const RUNTIME_RETENTION_POLICY_STATE = "runtime-retention-policy.json";

function cloneDefaultPolicy(): Record<
  HostInstalledRuntimeArtifact,
  HostRuntimeArtifactRetentionPolicy
> {
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

function runtimeRetentionPolicyStatePath(): string | undefined {
  const dataDir = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  if (!dataDir) return undefined;
  return path.join(dataDir, RUNTIME_RETENTION_POLICY_STATE);
}

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

function normalizeRetentionPolicyEntry({
  fallback,
  raw,
}: {
  fallback: HostRuntimeArtifactRetentionPolicy;
  raw?: HostRuntimeArtifactRetentionPolicy;
}): HostRuntimeArtifactRetentionPolicy {
  const keep_count =
    parseNonNegativeInt(raw?.keep_count) ?? fallback.keep_count;
  const max_bytes = parseNonNegativeInt(raw?.max_bytes);
  return {
    keep_count,
    ...(max_bytes != null ? { max_bytes } : {}),
  };
}

function envOverrideForArtifact(
  artifact: HostInstalledRuntimeArtifact,
): HostRuntimeArtifactRetentionPolicy | undefined {
  const keep_count =
    artifact === "project-host"
      ? parseNonNegativeInt(process.env.COCALC_PROJECT_HOST_RETENTION_COUNT)
      : artifact === "project-bundle"
        ? (parseNonNegativeInt(
            process.env.COCALC_PROJECT_BUNDLE_RETENTION_COUNT,
          ) ??
          parseNonNegativeInt(
            process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_COUNT,
          ))
        : (parseNonNegativeInt(
            process.env.COCALC_PROJECT_TOOLS_RETENTION_COUNT,
          ) ??
          parseNonNegativeInt(
            process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_COUNT,
          ));
  const max_bytes =
    artifact === "project-host"
      ? parseNonNegativeInt(process.env.COCALC_PROJECT_HOST_RETENTION_MAX_BYTES)
      : artifact === "project-bundle"
        ? (parseNonNegativeInt(
            process.env.COCALC_PROJECT_BUNDLE_RETENTION_MAX_BYTES,
          ) ??
          parseNonNegativeInt(
            process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_MAX_BYTES,
          ))
        : (parseNonNegativeInt(
            process.env.COCALC_PROJECT_TOOLS_RETENTION_MAX_BYTES,
          ) ??
          parseNonNegativeInt(
            process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_MAX_BYTES,
          ));
  if (keep_count == null && max_bytes == null) return undefined;
  return {
    ...(keep_count != null ? { keep_count } : {}),
    ...(max_bytes != null ? { max_bytes } : {}),
  } as HostRuntimeArtifactRetentionPolicy;
}

export function readConfiguredRuntimeRetentionPolicy():
  | HostRuntimeRetentionPolicy
  | undefined {
  const statePath = runtimeRetentionPolicyStatePath();
  if (!statePath) return undefined;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as HostRuntimeRetentionPolicy;
  } catch {
    return undefined;
  }
}

export function writeConfiguredRuntimeRetentionPolicy(
  policy: HostRuntimeRetentionPolicy,
): void {
  const statePath = runtimeRetentionPolicyStatePath();
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const normalized = effectiveRuntimeRetentionPolicy({ policy });
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(normalized, null, 2));
  fs.renameSync(`${statePath}.tmp`, statePath);
}

export function effectiveRuntimeRetentionPolicy({
  policy,
}: {
  policy?: HostRuntimeRetentionPolicy;
} = {}): Record<
  HostInstalledRuntimeArtifact,
  HostRuntimeArtifactRetentionPolicy
> {
  const defaults = cloneDefaultPolicy();
  const configured = policy ?? readConfiguredRuntimeRetentionPolicy();
  const resolved = {
    "project-host": normalizeRetentionPolicyEntry({
      fallback: defaults["project-host"],
      raw: configured?.["project-host"],
    }),
    "project-bundle": normalizeRetentionPolicyEntry({
      fallback: defaults["project-bundle"],
      raw: configured?.["project-bundle"],
    }),
    tools: normalizeRetentionPolicyEntry({
      fallback: defaults.tools,
      raw: configured?.tools,
    }),
  };
  for (const artifact of Object.keys(
    resolved,
  ) as HostInstalledRuntimeArtifact[]) {
    const override = envOverrideForArtifact(artifact);
    if (!override) continue;
    resolved[artifact] = normalizeRetentionPolicyEntry({
      fallback: resolved[artifact],
      raw: override,
    });
  }
  return resolved;
}

export function retentionPolicyForArtifact(
  artifact: HostInstalledRuntimeArtifact,
  policy?: HostRuntimeRetentionPolicy,
): HostRuntimeArtifactRetentionPolicy {
  return effectiveRuntimeRetentionPolicy({ policy })[artifact];
}
