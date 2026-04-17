/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  HostRuntimeHostAgentProjectHostAutomaticRollback,
  HostRuntimeHostAgentProjectHostObservation,
} from "@cocalc/conat/hub/api/hosts";
import type { HostLroState } from "../hooks/use-host-ops";

const PROJECT_HOST_ROLLOUT_OP_KINDS = new Set([
  "host-upgrade-software",
  "host-reconcile-software",
  "host-reconcile-runtime-deployments",
  "host-rollback-runtime-deployments",
]);

function toTimestamp(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const ts =
    value instanceof Date ? value.getTime() : Date.parse(`${value ?? ""}`);
  return Number.isFinite(ts) ? ts : undefined;
}

export function currentProjectHostAutomaticRollback({
  observation,
  currentVersion,
}: {
  observation?: HostRuntimeHostAgentProjectHostObservation;
  currentVersion?: string;
}): HostRuntimeHostAgentProjectHostAutomaticRollback | undefined {
  const rollback = observation?.last_automatic_rollback;
  if (!rollback) {
    return undefined;
  }
  if (currentVersion && rollback.rollback_version !== currentVersion) {
    return undefined;
  }
  return rollback;
}

export function shouldSuppressProjectHostFailedOp({
  op,
  currentVersion,
  observation,
}: {
  op?: HostLroState;
  currentVersion?: string;
  observation?: HostRuntimeHostAgentProjectHostObservation;
}): boolean {
  const rollback = currentProjectHostAutomaticRollback({
    observation,
    currentVersion,
  });
  if (!op?.summary || !rollback) {
    return false;
  }
  if (op.summary.status !== "failed") {
    return false;
  }
  const kind = op.summary.kind ?? op.kind;
  if (!kind || !PROJECT_HOST_ROLLOUT_OP_KINDS.has(kind)) {
    return false;
  }
  const opTs =
    toTimestamp(op.summary.updated_at) ??
    toTimestamp(op.summary.finished_at) ??
    toTimestamp(op.summary.created_at);
  const rollbackTs = toTimestamp(rollback.finished_at);
  if (opTs == null || rollbackTs == null) {
    return false;
  }
  return rollbackTs >= opTs;
}

export function projectHostRollbackReasonLabel(
  reason?: HostRuntimeHostAgentProjectHostAutomaticRollback["reason"],
): string {
  switch (reason) {
    case "health_deadline_exceeded":
      return "health deadline exceeded";
    default:
      return "automatic rollback";
  }
}
