/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Admin health and alerts for project host integrity: each running host's
// heartbeat carries the status of its root integrity watcher (process
// placement findings, host configuration changes) and since when a reboot has
// been pending to apply updates (project-host/host-integrity.ts).
//
// Alerts are report-only unless COCALC_HOST_INTEGRITY_ALERTS=alert: until then
// the conditions show in admin health and the bay log only.

import getLogger from "@cocalc/backend/logger";
import type { HostIntegrityStatus } from "@cocalc/conat/hub/api/hosts";
import type { LaunchHealthLevel } from "@cocalc/conat/hub/api/system";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  byHostId,
  conditionAlert,
  conditionCleared,
} from "@cocalc/server/hosts/condition-alert";

const logger = getLogger("server:hosts:host-integrity-health");

const HOST_ONLINE_WINDOW_MS = 5 * 60 * 1000;
// A finding seen this recently is a current condition (alerted); older ones
// stay visible in health for a day.
const CURRENT_FINDING_MS = 10 * 60 * 1000;
const RECENT_FINDING_MS = 24 * 60 * 60 * 1000;
export const REBOOT_PENDING_ALERT_MS = 48 * 60 * 60 * 1000;
const ALERT_INTERVAL_MS = 60 * 1000;
const ALERT_REMINDER_MINUTES = 6 * 60;
const ALERT_SUBJECT_PREFIX = "Host integrity: ";
const LOCK_KEY = "project_host_integrity_alerts";
const MAX_DETAILS_PER_HOST = 5;

export type HostIntegrityRow = {
  id: string;
  name: string | null;
  integrity: HostIntegrityStatus | null;
};

export type HostIntegrityCondition = {
  host_id: string;
  host_name: string | null;
  kind: "processes" | "config" | "watcher" | "reboot";
  level: "critical" | "warning";
  subject: string;
  // stable facts only (the alert dedupe compares bodies)
  facts: string[];
  // shown in health, not in alerts (counts and times change every scan)
  details: string[];
};

export interface HostIntegritySummary {
  active_hosts: number;
  // hosts whose software predates the report
  unreported_hosts: number;
  conditions: HostIntegrityCondition[];
}

function hostLabel(row: HostIntegrityRow): string {
  return row.name ? `${row.name} (${row.id})` : row.id;
}

function ms(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function summarizeHostIntegrity(
  rows: HostIntegrityRow[],
  now = Date.now(),
): HostIntegritySummary {
  const conditions: HostIntegrityCondition[] = [];
  let unreported = 0;
  for (const row of byHostId(rows)) {
    const integrity = row.integrity;
    if (integrity == null || typeof integrity !== "object") {
      unreported += 1;
      continue;
    }
    const label = hostLabel(row);
    const base = { host_id: row.id, host_name: row.name };
    if (integrity.watcher !== "running") {
      conditions.push({
        ...base,
        kind: "watcher",
        level: "warning",
        subject: `${ALERT_SUBJECT_PREFIX}${row.name ?? row.id}: watcher not reporting`,
        facts: [`${label}: integrity watcher ${integrity.watcher}`],
        details: [
          `${label}: integrity watcher ${integrity.watcher}${integrity.heartbeat_at ? ` (last status ${integrity.heartbeat_at})` : ""}`,
        ],
      });
    }
    const recent = (integrity.findings ?? []).filter((f) => {
      const seen = ms(f.last_seen);
      return seen != null && now - seen <= RECENT_FINDING_MS;
    });
    if (recent.length > 0) {
      const current = recent.filter(
        (f) => now - (ms(f.last_seen) ?? 0) <= CURRENT_FINDING_MS,
      );
      const critical = recent.some((f) => f.severity === "critical");
      const describe = (f: (typeof recent)[number]) =>
        `${f.rule}: ${f.exe || f.comm} uid ${f.uids?.[0]} in the ${f.userns} user namespace (parents ${(f.parents ?? []).join(" < ") || "none"})`;
      conditions.push({
        ...base,
        kind: "processes",
        level: critical ? "critical" : "warning",
        subject: `${ALERT_SUBJECT_PREFIX}${row.name ?? row.id}: unexpected process placement`,
        // Alerted only while a finding is current.
        facts: current.map(describe).sort(),
        details: recent
          .slice(0, MAX_DETAILS_PER_HOST)
          .map(
            (f) =>
              `${label}: ${f.severity} ${describe(f)}; seen ${f.count}x, first ${f.first_seen}, last ${f.last_seen}`,
          ),
      });
    }
    const changes = integrity.config_changes ?? [];
    if (changes.length > 0) {
      conditions.push({
        ...base,
        kind: "config",
        level: "warning",
        subject: `${ALERT_SUBJECT_PREFIX}${row.name ?? row.id}: host configuration changed`,
        facts: changes.map((c) => `${label}: ${c.path} changed`).sort(),
        details: changes
          .slice(0, MAX_DETAILS_PER_HOST)
          .map(
            (c) => `${label}: ${c.path} changed (first seen ${c.first_seen})`,
          ),
      });
    }
    const since = ms(integrity.reboot_required_since);
    if (since != null && now - since > REBOOT_PENDING_ALERT_MS) {
      const days = Math.floor((now - since) / (24 * 60 * 60 * 1000));
      conditions.push({
        ...base,
        kind: "reboot",
        level: "warning",
        subject: `${ALERT_SUBJECT_PREFIX}${row.name ?? row.id}: reboot pending for updates`,
        facts: [
          `${label}: a reboot has been pending since ${integrity.reboot_required_since} to apply updates (e.g. a kernel fix)`,
        ],
        details: [
          `${label}: reboot pending for updates for ${days} day${days === 1 ? "" : "s"} (since ${integrity.reboot_required_since})`,
        ],
      });
    }
  }
  return {
    active_hosts: rows.length,
    unreported_hosts: unreported,
    conditions,
  };
}

export async function getHostIntegritySummary(): Promise<HostIntegritySummary> {
  const bayId = getConfiguredBayId();
  const { rows } = await getPool().query<HostIntegrityRow>(
    `SELECT id, name, metadata->'host_integrity' AS integrity
     FROM project_hosts
     WHERE deleted IS NULL
       AND status = 'running'
       AND last_seen >= NOW() - ($1::double precision * INTERVAL '1 millisecond')
       AND COALESCE(NULLIF(bay_id, ''), $2) = $2
     ORDER BY name, id`,
    [HOST_ONLINE_WINDOW_MS, bayId],
  );
  return summarizeHostIntegrity(rows);
}

export function hostIntegrityHealth(
  result: PromiseSettledResult<HostIntegritySummary>,
): { level: LaunchHealthLevel; summary: string; details: string[] } {
  if (result.status === "rejected") {
    return {
      level: "unknown",
      summary: "Unable to read project host integrity reports.",
      details: [`${result.reason}`],
    };
  }
  const { active_hosts, unreported_hosts, conditions } = result.value;
  const reporting = active_hosts - unreported_hosts;
  const unreported = unreported_hosts
    ? ` ${unreported_hosts} host${unreported_hosts === 1 ? " does" : "s do"} not report it yet.`
    : "";
  const level: LaunchHealthLevel = conditions.some(
    (c) => c.level === "critical",
  )
    ? "critical"
    : conditions.length > 0
      ? "warning"
      : "healthy";
  const hosts = new Set(conditions.map((c) => c.host_id)).size;
  return {
    level,
    summary:
      conditions.length > 0
        ? `${hosts}/${reporting} reporting hosts have integrity conditions (${alertMode() === "alert" ? "alerting" : "report-only"}).${unreported}`
        : `${reporting}/${active_hosts} active hosts report no integrity conditions.${unreported}`,
    details: conditions.flatMap((c) => c.details),
  };
}

export function alertMode(): "alert" | "report" {
  return `${process.env.COCALC_HOST_INTEGRITY_ALERTS ?? ""}`.trim() === "alert"
    ? "alert"
    : "report";
}

async function activeAlertSubjects(): Promise<string[]> {
  const { rows } = await getPool().query<{ subject: string }>(
    `SELECT subject FROM admin_alert_state WHERE active AND subject LIKE $1`,
    [`${ALERT_SUBJECT_PREFIX}%`],
  );
  return rows.map((row) => row.subject);
}

export async function runHostIntegrityAlertPass(): Promise<number> {
  const summary = await getHostIntegritySummary();
  // Only current conditions alert (a finding last seen hours ago is history).
  const alerting = summary.conditions.filter((c) => c.facts.length > 0);
  const mode = alertMode();
  for (const condition of alerting) {
    if (mode !== "alert") {
      logger.warn("host integrity condition (report-only)", {
        host_id: condition.host_id,
        kind: condition.kind,
        level: condition.level,
        facts: condition.facts,
      });
      continue;
    }
    await conditionAlert({
      subject: condition.subject,
      body: [
        condition.level === "critical"
          ? "A project host reports a critical integrity finding."
          : "A project host reports an integrity condition.",
        "",
        ...condition.facts.map((fact) => `- ${fact}`),
      ].join("\n"),
      reminderMinutes: ALERT_REMINDER_MINUTES,
    });
  }
  const current = new Set(alerting.map((c) => c.subject));
  for (const subject of await activeAlertSubjects()) {
    if (!current.has(subject)) await conditionCleared(subject);
  }
  return alerting.length;
}

let started = false;

export function startHostIntegrityAlerts({
  interval_ms = ALERT_INTERVAL_MS,
}: { interval_ms?: number } = {}): void {
  if (started || process.env.COCALC_HOST_INTEGRITY_ALERTS === "off") return;
  started = true;
  const run = async () => {
    try {
      // One hub worker at a time.
      await withSessionAdvisoryLock({
        lockKey: LOCK_KEY,
        fn: runHostIntegrityAlertPass,
      });
    } catch (err) {
      logger.warn("host integrity alert pass failed", { err: `${err}` });
    }
  };
  const timer = setInterval(() => void run(), interval_ms);
  timer.unref?.();
  logger.info("host integrity alerts started", {
    interval_ms,
    mode: alertMode(),
  });
}
