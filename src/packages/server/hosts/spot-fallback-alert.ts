/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Alert admins when Spot hosts stay on a fallback (another machine type or
// Standard pricing) for more than a day. Recovery schedules the return after
// max_standard_runtime_minutes (24 h by default), so a host still on a
// fallback after that has a return that failed or keeps being deferred.

import getPool from "@cocalc/database/pool";
import {
  desiredPricingModel,
  effectivePricingModel,
} from "@cocalc/server/cloud/spot-restore";
import { byHostId, conditionAlert, conditionCleared } from "./condition-alert";

export const SPOT_FALLBACK_ALERT_SUBJECT =
  "Spot hosts have been on a fallback for more than 24 hours";
export const SPOT_FALLBACK_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const SPOT_FALLBACK_ALERT_REMINDER_MINUTES = 24 * 60;
const SPOT_FALLBACK_ALERT_LIMIT = 50;

export interface SpotFallbackAlertRow {
  id: string;
  name: string;
  kind: "spot_alternate" | "standard_fallback";
}

interface HostRow {
  id: string;
  metadata?: Record<string, any> | null;
}

function timestampMs(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const ms = new Date(value as any).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

// The host's fallback if it has lasted longer than SPOT_FALLBACK_ALERT_AFTER_MS.
export function spotFallbackAlertRow(
  row: HostRow,
  now = Date.now(),
): SpotFallbackAlertRow | undefined {
  const metadata = row.metadata ?? {};
  if (desiredPricingModel(row as any) !== "spot") return undefined;
  const state = metadata.spot_recovery_state ?? {};
  const phase = `${state.phase ?? ""}`;
  const desired = `${metadata.machine?.machine_type ?? ""}`.trim();
  const active = `${state.active_machine_type ?? ""}`.trim() || desired;
  let kind: SpotFallbackAlertRow["kind"];
  let since: number | undefined;
  if (
    effectivePricingModel(row as any) === "on_demand" ||
    phase === "running_standard_fallback" ||
    phase === "probing_spot"
  ) {
    kind = "standard_fallback";
    since = timestampMs(state.fallback_started_at);
  } else if (desired && active !== desired) {
    kind = "spot_alternate";
    since = timestampMs(state.machine_type_attempt_started_at);
  } else {
    return undefined;
  }
  if (since == null || now - since <= SPOT_FALLBACK_ALERT_AFTER_MS) {
    return undefined;
  }
  const name =
    `${metadata.name ?? metadata.display_name ?? ""}`.trim() || row.id;
  return { id: row.id, name, kind };
}

// Counts and host names only: stable facts, so an unchanged condition has an
// unchanged body (see condition-alert.ts).
export function formatSpotFallbackAlertBody(
  rows: SpotFallbackAlertRow[],
): string {
  const section = (kind: SpotFallbackAlertRow["kind"], title: string) => {
    const hosts = rows.filter((row) => row.kind === kind);
    if (!hosts.length) return [];
    return [
      `${title}: ${hosts.length}`,
      ...hosts
        .slice(0, SPOT_FALLBACK_ALERT_LIMIT)
        .map((row) => `- ${row.name}`),
      ...(hosts.length > SPOT_FALLBACK_ALERT_LIMIT
        ? [`- ... ${hosts.length - SPOT_FALLBACK_ALERT_LIMIT} more`]
        : []),
      "",
    ];
  };
  return [
    `${rows.length} Spot host${rows.length === 1 ? " has" : "s have"} been on a fallback for more than 24 hours. CoCalc should have moved ${rows.length === 1 ? "it" : "them"} back by now; check the host's recovery events.`,
    "",
    ...section("spot_alternate", "On Spot, but another machine type"),
    ...section("standard_fallback", "On Standard pricing"),
  ]
    .join("\n")
    .trimEnd();
}

export async function runSpotFallbackAlertCheck(
  now = Date.now(),
): Promise<number> {
  const { rows } = await getPool().query<HostRow>(
    `SELECT id, metadata
       FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND metadata ? 'spot_recovery_state'
      LIMIT 1000`,
  );
  const alerts = byHostId(
    rows
      .map((row) => spotFallbackAlertRow(row, now))
      .filter((row): row is SpotFallbackAlertRow => row != null),
  );
  if (!alerts.length) {
    await conditionCleared(SPOT_FALLBACK_ALERT_SUBJECT);
    return 0;
  }
  await conditionAlert({
    subject: SPOT_FALLBACK_ALERT_SUBJECT,
    body: formatSpotFallbackAlertBody(alerts),
    reminderMinutes: SPOT_FALLBACK_ALERT_REMINDER_MINUTES,
  });
  return alerts.length;
}
