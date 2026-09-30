/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Kept free of process/sudo dependencies so agent launchers can import it.

import { normalizeRunQuota } from "./run-quota";

export type ProjectNetworkPolicy = "disabled" | "normal";

export function projectNetworkPolicyFromRunQuota(
  rawRunQuota: unknown,
): ProjectNetworkPolicy {
  const runQuota = normalizeRunQuota(rawRunQuota);
  return runQuota?.network === true || runQuota?.network === 1
    ? "normal"
    : "disabled";
}
