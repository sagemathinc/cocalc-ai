/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hostname, release } from "node:os";

import { executeCode } from "@cocalc/backend/execute-code";
import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";

const ROOTCTL = "/usr/local/sbin/cocalc-project-host-rootctl";
const MAX_OUTPUT_BYTES = 512 * 1024;

type Execute = typeof executeCode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function unavailableSnapshot({
  started,
  code,
}: {
  started: number;
  code: string;
}): HostIntrusionSnapshotResponse {
  return {
    version: 1,
    captured_at: new Date(started).toISOString(),
    duration_ms: Math.max(0, Date.now() - started),
    hostname: hostname(),
    kernel: release(),
    boot_id: "",
    coverage: "unavailable",
    accounts: { uid_zero: [], interactive: [] },
    host_processes: {
      scanned_process_count: 0,
      process_count: 0,
      summary: [],
      findings: [],
    },
    persistence: { files: [], truncated: false },
    privileged_files: { writable: [], suid_sgid: [], capabilities: [] },
    services: { enabled: [], failed: [] },
    network: { listeners: [], established: [] },
    authentication_7d: { accepted: [], failed: 0, invalid_user: 0 },
    kernel_signals_7d: {},
    package_integrity: { manager: "unavailable", differences: [] },
    issues: [{ section: "collector", code }],
    truncated: {},
  };
}

export function parseIntrusionSnapshot(
  raw: string,
): HostIntrusionSnapshotResponse {
  if (Buffer.byteLength(raw, "utf8") >= MAX_OUTPUT_BYTES) {
    throw new Error("intrusion snapshot exceeded output limit");
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    typeof parsed.captured_at !== "string" ||
    typeof parsed.duration_ms !== "number" ||
    typeof parsed.hostname !== "string" ||
    typeof parsed.kernel !== "string" ||
    typeof parsed.boot_id !== "string" ||
    !["complete", "partial", "unavailable"].includes(
      `${parsed.coverage ?? ""}`,
    ) ||
    !isRecord(parsed.accounts) ||
    !Array.isArray(parsed.accounts.uid_zero) ||
    !Array.isArray(parsed.accounts.interactive) ||
    !isRecord(parsed.host_processes) ||
    typeof parsed.host_processes.scanned_process_count !== "number" ||
    typeof parsed.host_processes.process_count !== "number" ||
    !Array.isArray(parsed.host_processes.summary) ||
    !Array.isArray(parsed.host_processes.findings) ||
    !isRecord(parsed.persistence) ||
    !Array.isArray(parsed.persistence.files) ||
    typeof parsed.persistence.truncated !== "boolean" ||
    !isRecord(parsed.privileged_files) ||
    !Array.isArray(parsed.privileged_files.writable) ||
    !Array.isArray(parsed.privileged_files.suid_sgid) ||
    !Array.isArray(parsed.privileged_files.capabilities) ||
    !isRecord(parsed.services) ||
    !Array.isArray(parsed.services.enabled) ||
    !Array.isArray(parsed.services.failed) ||
    !isRecord(parsed.network) ||
    !Array.isArray(parsed.network.listeners) ||
    !Array.isArray(parsed.network.established) ||
    !isRecord(parsed.authentication_7d) ||
    !Array.isArray(parsed.authentication_7d.accepted) ||
    typeof parsed.authentication_7d.failed !== "number" ||
    typeof parsed.authentication_7d.invalid_user !== "number" ||
    !isRecord(parsed.kernel_signals_7d) ||
    !isRecord(parsed.package_integrity) ||
    !["dpkg", "unavailable"].includes(
      `${parsed.package_integrity.manager ?? ""}`,
    ) ||
    !Array.isArray(parsed.package_integrity.differences) ||
    !Array.isArray(parsed.issues) ||
    !isRecord(parsed.truncated)
  ) {
    throw new Error("invalid intrusion snapshot response");
  }
  return parsed as unknown as HostIntrusionSnapshotResponse;
}

export async function collectIntrusionSnapshot({
  execute = executeCode,
}: { execute?: Execute } = {}): Promise<HostIntrusionSnapshotResponse> {
  const started = Date.now();
  let result: Awaited<ReturnType<Execute>>;
  try {
    result = await execute({
      command: "sudo",
      args: ["-n", ROOTCTL, "intrusion-snapshot"],
      timeout: 120,
      max_output: MAX_OUTPUT_BYTES,
      err_on_exit: false,
    });
  } catch {
    return unavailableSnapshot({ started, code: "ROOT_HELPER_EXEC_FAILED" });
  }
  if (result.exit_code !== 0) {
    return unavailableSnapshot({ started, code: "ROOT_HELPER_FAILED" });
  }
  try {
    return parseIntrusionSnapshot(String(result.stdout ?? ""));
  } catch {
    return unavailableSnapshot({ started, code: "ROOT_HELPER_INVALID_OUTPUT" });
  }
}
