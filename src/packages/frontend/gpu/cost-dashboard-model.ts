/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { moneyAdd, toDecimal } from "@cocalc/util/money";
import type {
  DashboardPod,
  GpuDashboardScope,
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

export function podStateLabel(
  pod: Pick<GpuPodSummary, "state" | "unmanaged_at">,
): string {
  // A forced key removal left it outside CoCalc's management.
  if (pod.unmanaged_at) return "Unmanaged (may still bill at RunPod)";
  return STATE_LABELS[pod.state] ?? pod.state;
}

/** A pod that may still cost money: everything until deletion is confirmed. */
export function isLivePod(pod: Pick<GpuPodSummary, "state">): boolean {
  return pod.state !== "terminated" && pod.state !== "failed";
}

export function livePods<T extends GpuPodSummary>(pods: T[]): T[] {
  return pods
    .filter(isLivePod)
    .sort((a, b) => a.created.localeCompare(b.created));
}

/** Total hourly rate of the priced pods, and how many have no price yet (they
 * are not counted as zero). */
export function hourlyRate(pods: Pick<GpuPodSummary, "cost_per_hr">[]): {
  total: string;
  unpriced: number;
} {
  let total = toDecimal(0);
  let unpriced = 0;
  for (const pod of pods) {
    if (pod.cost_per_hr == null) unpriced += 1;
    else total = moneyAdd(total, pod.cost_per_hr);
  }
  return { total: total.toString(), unpriced };
}

export function spendTotal(row: {
  spent_usd: string;
  live_estimate_usd: string;
  held_usd: string;
}): string {
  return moneyAdd(
    moneyAdd(row.spent_usd, row.live_estimate_usd),
    row.held_usd,
  ).toString();
}

/** A spend row's label: the person's name (or "You"), the agent, the
 * project's title, or the pod's handle. */
export function spendRowLabel(
  row: Pick<GpuSpendRow, "key" | "label">,
  group_by: GpuSpendGroupBy,
  labels: {
    viewerAccountId?: string;
    names?: Record<string, string | undefined>;
    projectTitle?: (project_id: string) => string | undefined;
  },
): string {
  switch (group_by) {
    case "beneficiary":
      if (labels.viewerAccountId != null && row.key === labels.viewerAccountId)
        return "You";
      return labels.names?.[row.key] || "Unknown person";
    case "agent":
      if (row.key === "chat-session") return "Chat sessions";
      return row.key ? `Agent ${row.key.slice(0, 8)}` : "No agent (a person)";
    case "project":
      return row.key
        ? (labels.projectTitle?.(row.key) ?? `Project ${row.key.slice(0, 8)}`)
        : "No project";
    case "pod":
      return row.label ?? row.key.slice(0, 8);
  }
}

export function podGpuLabel(
  pod: Pick<GpuPodSummary, "gpu_count" | "gpu_type_id" | "cloud">,
): string {
  const cloud = pod.cloud === "COMMUNITY" ? "Community" : "Secure";
  return `${pod.gpu_count} × ${pod.gpu_type_id} (${cloud} Cloud)`;
}

/** "You" only when the viewer is known to be the beneficiary; a missing name
 * is never assumed to be the viewer. */
export function podOwnerLabel(
  pod: Pick<
    DashboardPod,
    "beneficiary_name" | "beneficiary_account_id" | "agent_id"
  >,
  viewerAccountId?: string,
): string {
  const who =
    viewerAccountId != null && pod.beneficiary_account_id === viewerAccountId
      ? "You"
      : pod.beneficiary_name || "Unknown person";
  return pod.agent_id ? `${who} (agent)` : who;
}

/** Completes "GPU pods ..." for a scope, so the confirmation always names the
 * pods the kill switch will actually terminate. */
export function defaultScopeLabel(scope: GpuDashboardScope): string {
  if (scope === "funded") return "your RunPod key pays for";
  return "in this course";
}
