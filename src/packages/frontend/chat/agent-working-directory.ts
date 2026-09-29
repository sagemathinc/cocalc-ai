/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

function field(value: any, key: string): unknown {
  return typeof value?.get === "function" ? value.get(key) : value?.[key];
}

/** Runtime cwd is authoritative for ACP; older agents store it in acp_config. */
export function agentWorkingDirectory(metadata: unknown): string | undefined {
  const profile = field(field(metadata, "agent_runtime"), "profile");
  for (const value of [
    field(profile, "cwd"),
    field(field(metadata, "acp_config"), "workingDirectory"),
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}
