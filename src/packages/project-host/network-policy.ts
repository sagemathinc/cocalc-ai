/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import { isValidUUID } from "@cocalc/util/misc";

import { normalizeRunQuota } from "./run-quota";

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

export type ProjectNetworkPolicy = "disabled" | "normal";

async function runPolicyCommand(args: string[]): Promise<void> {
  const { stdout, stderr, exit_code } = await executeCode({
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, ...args],
    timeout: 60,
    err_on_exit: false,
  });
  if (exit_code) {
    throw new Error(
      `project network policy command failed (exit ${exit_code}): ${
        stderr || stdout || ""
      }`.trim(),
    );
  }
}

function validateProjectId(project_id: string): void {
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project id");
  }
}

export function projectNetworkPolicyFromRunQuota(
  rawRunQuota: unknown,
): ProjectNetworkPolicy {
  const runQuota = normalizeRunQuota(rawRunQuota);
  return runQuota?.network === true || runQuota?.network === 1
    ? "normal"
    : "disabled";
}

// Persist the policy before the startup cgroup exists. The privileged startup
// helper installs the corresponding nftables rule before Podman can execute.
export async function prepareProjectNetworkPolicy({
  project_id,
  policy,
}: {
  project_id: string;
  policy: ProjectNetworkPolicy;
}): Promise<void> {
  validateProjectId(project_id);
  await runPolicyCommand([
    "prepare-project-network-policy",
    project_id,
    policy,
  ]);
}

export async function setProjectNetworkPolicy({
  project_id,
  policy,
}: {
  project_id: string;
  policy: ProjectNetworkPolicy;
}): Promise<void> {
  validateProjectId(project_id);
  await runPolicyCommand(["set-project-network-policy", project_id, policy]);
}

export async function verifyProjectNetworkPolicy({
  project_id,
  policy,
}: {
  project_id: string;
  policy: ProjectNetworkPolicy;
}): Promise<void> {
  validateProjectId(project_id);
  await runPolicyCommand(["verify-project-network-policy", project_id, policy]);
}
