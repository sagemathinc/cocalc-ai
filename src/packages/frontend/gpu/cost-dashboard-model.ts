/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { moneyAdd, toDecimal } from "@cocalc/util/money";
import type {
  GpuPodState,
  GpuPodSummary,
  GpuSpendGroupBy,
  GpuSpendRow,
} from "./types";

export type GpuSpendPeriod = "24h" | "7d" | "30d";

export const PERIOD_LABELS: Record<GpuSpendPeriod, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const PERIOD_MS: Record<GpuSpendPeriod, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export const GROUP_BY_LABELS: Record<GpuSpendGroupBy, string> = {
  beneficiary: "Person",
  agent: "Agent",
  project: "Project",
  pod: "Pod",
};

const STATE_LABELS: Record<GpuPodState, string> = {
  intent: "Starting",
  creating: "Starting",
  ambiguous: "Checking",
  running: "Running",
  stopped: "Stopped (disk still billed)",
  terminating: "Terminating",
  terminated: "Terminated",
  failed: "Failed",
};

export function periodSince(period: GpuSpendPeriod, now: number): string {
  return new Date(now - PERIOD_MS[period]).toISOString();
}

export function podStateLabel(state: GpuPodState): string {
  return STATE_LABELS[state] ?? state;
}

/** A pod that may still cost money: everything until deletion is confirmed. */
export function isLivePod(pod: Pick<GpuPodSummary, "state">): boolean {
  return pod.state !== "terminated" && pod.state !== "failed";
}

export function livePods(pods: GpuPodSummary[]): GpuPodSummary[] {
  return pods
    .filter(isLivePod)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function hourlyRate(pods: GpuPodSummary[]): string {
  return pods
    .reduce((sum, pod) => moneyAdd(sum, pod.cost_per_hr), toDecimal(0))
    .toString();
}

export function spendTotals(rows: GpuSpendRow[]): {
  estimated: string;
  billed: string | null;
} {
  let estimated = toDecimal(0);
  let billed = toDecimal(0);
  let anyBilled = false;
  for (const row of rows) {
    estimated = moneyAdd(estimated, row.estimated);
    if (row.billed != null) {
      anyBilled = true;
      billed = moneyAdd(billed, row.billed);
    }
  }
  return {
    estimated: estimated.toString(),
    billed: anyBilled ? billed.toString() : null,
  };
}

export function podGpuLabel(
  pod: Pick<GpuPodSummary, "gpu_count" | "gpu_type_id" | "cloud">,
): string {
  const cloud = pod.cloud === "COMMUNITY" ? "Community" : "Secure";
  return `${pod.gpu_count} × ${pod.gpu_type_id} (${cloud} Cloud)`;
}

export function podOwnerLabel(
  pod: Pick<GpuPodSummary, "beneficiary_name" | "agent_id">,
): string {
  const who = pod.beneficiary_name || "You";
  return pod.agent_id ? `${who} (agent)` : who;
}
