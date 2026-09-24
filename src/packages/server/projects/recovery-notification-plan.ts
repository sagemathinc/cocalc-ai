/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  PAYING_BACKUP_INCIDENT_DELAY_MS,
  PAYING_SNAPSHOT_INCIDENT_DELAY_MS,
} from "@cocalc/util/consts/project-recovery";
import type { ProjectRecoveryHealth } from "./maintenance-status";

export interface RecoveryIncident {
  code:
    | "paying_debt"
    | "unclassified_debt"
    | "paying_failures"
    | "paying_queue_stalled"
    | "pressure_telemetry_missing"
    | "objective_coverage_gap";
  subject: string;
  body: string;
}

type RecoveryInput = {
  bayId: string;
  checkedAt: string;
  health: ProjectRecoveryHealth;
  recentPayingCompletions: Array<{
    host_id: string;
    kind: "snapshot" | "backup";
    succeeded: number;
  }>;
  missingPressureHosts: string[];
};

const MAX_DETAIL_ROWS = 20;
const STALLED_QUEUE_DELAY_SECONDS = {
  snapshot: 30 * 60,
  backup: 2 * 60 * 60,
};

function minutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}

function incidentScope(keys: string[]): string {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return "host unresolved";
  if (sorted.length === 1) return sorted[0];
  const fingerprint = createHash("sha256")
    .update(sorted.join("\n"))
    .digest("hex")
    .slice(0, 10);
  return `${sorted.length} host lanes ${fingerprint}`;
}

function groupScope(groups: ProjectRecoveryHealth["by_host_class"]): string {
  return incidentScope(groups.map((group) => `${group.host_id}/${group.kind}`));
}

function incidentThresholdSeconds(kind: "snapshot" | "backup"): number {
  return (
    (kind === "snapshot"
      ? PAYING_SNAPSHOT_INCIDENT_DELAY_MS
      : PAYING_BACKUP_INCIDENT_DELAY_MS) / 1000
  );
}

function groupLine(
  group: ProjectRecoveryHealth["by_host_class"][number],
): string {
  return `${group.host_id} ${group.storage_service_class} ${group.kind}: ${group.overdue_count} overdue, oldest ${minutes(group.oldest_delay_seconds)}m, ${group.unknown_count} unknown, ${group.repeated_failures} repeated failures`;
}

function oldestDebtLines(health: ProjectRecoveryHealth): string[] {
  return health.oldest_debt
    .filter((item) => item.storage_service_class !== "unclassified")
    .slice(0, MAX_DETAIL_ROWS)
    .map(
      (item) =>
        `${item.storage_service_class} ${item.kind} project ${item.project_id} on ${item.host_id}: due ${item.due_at}, delayed ${minutes(item.delay_seconds)}m`,
    );
}

export function stalledPayingRecoveryQueues({
  health,
  recentPayingCompletions,
}: Pick<
  RecoveryInput,
  "health" | "recentPayingCompletions"
>): ProjectRecoveryHealth["by_host_class"] {
  return health.by_host_class.filter((group) => {
    if (
      group.storage_service_class !== "paying" ||
      group.overdue_count === 0 ||
      group.oldest_delay_seconds < STALLED_QUEUE_DELAY_SECONDS[group.kind]
    ) {
      return false;
    }
    return !recentPayingCompletions.some(
      (completion) =>
        completion.host_id === group.host_id &&
        completion.kind === group.kind &&
        completion.succeeded > 0,
    );
  });
}

export function buildProjectRecoveryNotificationPlan({
  bayId,
  checkedAt,
  health,
  recentPayingCompletions,
  missingPressureHosts,
}: RecoveryInput): { incidents: RecoveryIncident[]; dailyReport: string } {
  const incidents: RecoveryIncident[] = [];
  const header = `Owning bay: ${bayId}\nChecked: ${checkedAt}`;

  if (health.paying_snapshot_overdue || health.paying_backup_overdue) {
    const affected = health.by_host_class.filter(
      (group) =>
        group.storage_service_class === "paying" &&
        group.oldest_delay_seconds > incidentThresholdSeconds(group.kind),
    );
    incidents.push({
      code: "paying_debt",
      subject: `Project recovery paying debt on ${bayId}: ${groupScope(affected)}`,
      body: [
        header,
        `${health.paying_snapshot_overdue} paying snapshots passed the two-hour incident threshold; ${health.paying_backup_overdue} paying backups passed the twelve-hour incident threshold.`,
        ...oldestDebtLines(health).filter((line) => line.startsWith("paying ")),
        "Inspect project-recovery health and the affected project's Recovery view. Keep its original due time until a recovery point is confirmed.",
      ].join("\n"),
    });
  }

  if (
    health.unclassified_snapshot_overdue ||
    health.unclassified_backup_overdue
  ) {
    const affected = health.by_host_class.filter(
      (group) =>
        group.storage_service_class === "unclassified" &&
        group.oldest_delay_seconds > incidentThresholdSeconds(group.kind),
    );
    incidents.push({
      code: "unclassified_debt",
      subject: `Project recovery funding classification missing for late debt on ${bayId}: ${groupScope(affected)}`,
      body: [
        header,
        `${health.unclassified_snapshot_overdue} snapshots and ${health.unclassified_backup_overdue} backups passed the paying incident thresholds without a confirmed funding class. Resolve the payer classification; do not assume these projects are free.`,
        ...health.oldest_debt
          .filter((item) => item.storage_service_class === "unclassified")
          .slice(0, MAX_DETAIL_ROWS)
          .map(
            (item) =>
              `${item.kind} project ${item.project_id} on ${item.host_id}: due ${item.due_at}, delayed ${minutes(item.delay_seconds)}m`,
          ),
      ].join("\n"),
    });
  }

  if (
    health.paying_snapshot_repeated_failures ||
    health.paying_backup_repeated_failures
  ) {
    const affected = health.by_host_class.filter(
      (group) =>
        group.storage_service_class === "paying" && group.repeated_failures > 0,
    );
    incidents.push({
      code: "paying_failures",
      subject: `Project recovery repeated paying failures on ${bayId}: ${groupScope(affected)}`,
      body: [
        header,
        `${health.paying_snapshot_repeated_failures} paying snapshot and ${health.paying_backup_repeated_failures} paying backup obligations have repeated failures.`,
        ...affected.slice(0, MAX_DETAIL_ROWS).map(groupLine),
      ].join("\n"),
    });
  }

  const stalled = stalledPayingRecoveryQueues({
    health,
    recentPayingCompletions,
  });
  if (stalled.length) {
    incidents.push({
      code: "paying_queue_stalled",
      subject: `Project recovery paying queue has no completions on ${bayId}: ${groupScope(stalled)}`,
      body: [
        header,
        "The following paying queues are overdue and have no confirmed completion in the last 30 minutes for snapshots or two hours for backups:",
        ...stalled.slice(0, MAX_DETAIL_ROWS).map(groupLine),
        `Additional affected host/kind groups: ${Math.max(0, stalled.length - MAX_DETAIL_ROWS)}`,
      ].join("\n"),
    });
  }

  if (missingPressureHosts.length) {
    incidents.push({
      code: "pressure_telemetry_missing",
      subject: `Project recovery host pressure telemetry missing on ${bayId}: ${incidentScope(missingPressureHosts)}`,
      body: [
        header,
        `${missingPressureHosts.length} hosts with provisioned projects have no valid storage-pressure sample in the last five minutes.`,
        ...missingPressureHosts.slice(0, MAX_DETAIL_ROWS),
        `Additional affected hosts: ${Math.max(0, missingPressureHosts.length - MAX_DETAIL_ROWS)}`,
      ].join("\n"),
    });
  }

  if (health.unaccounted_snapshot_due || health.unaccounted_backup_due) {
    incidents.push({
      code: "objective_coverage_gap",
      subject: `Project recovery objective accounting gap on ${bayId}`,
      body: [
        header,
        `${health.unaccounted_snapshot_due} snapshot and ${health.unaccounted_backup_due} backup obligations were due more than one hour ago but have no covering objective record.`,
        "Inspect the owning bay's project recovery health, host reconciliation, and maintenance reports before using 30-day objective percentages.",
      ].join("\n"),
    });
  }

  const groups = health.by_host_class
    .filter((group) => ["paying", "free"].includes(group.storage_service_class))
    .slice(0, MAX_DETAIL_ROWS)
    .map(groupLine);
  const dailyReport = [
    `Project recovery daily debt report for ${bayId}`,
    `Checked: ${checkedAt}`,
    `Paying incident thresholds: ${health.paying_snapshot_overdue} snapshots, ${health.paying_backup_overdue} backups.`,
    `Unknown host/status: ${health.unknown_snapshot_status} snapshots, ${health.unknown_backup_status} backups.`,
    `Unaccounted due obligations: ${health.unaccounted_snapshot_due} snapshots, ${health.unaccounted_backup_due} backups.`,
    `Oldest delay: snapshots ${minutes(health.oldest_snapshot_delay_seconds)}m, backups ${minutes(health.oldest_backup_delay_seconds)}m.`,
    "",
    "Debt by host and funding class:",
    ...(groups.length ? groups : ["No paying or free project debt."]),
    "",
    "Oldest paying and free obligations:",
    ...(oldestDebtLines(health).length
      ? oldestDebtLines(health)
      : ["No overdue paying or free obligations."]),
  ].join("\n");
  return { incidents, dailyReport };
}
