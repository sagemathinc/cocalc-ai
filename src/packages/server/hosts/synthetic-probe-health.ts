/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The admin health "synthetic smoke" check. Two kinds of probe run a project
through its lifecycle: the admin smoke (`cocalc admin smoke`, run by hand and
in releases) and each running host's own synthetic probe, which the bay runs
on a schedule (runtime-maintenance.ts). Either one, when current and passing,
shows that projects start; failures and overdue host probes are reported per
host.
*/

import type {
  LaunchHealthLevel,
  LaunchSmokeResult,
} from "@cocalc/conat/hub/api/system";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { syntheticProbeOverdueAfterMs } from "./runtime-maintenance";

// An admin smoke run counts as current for this long.
export const ADMIN_SMOKE_FRESH_MS = 60 * 60 * 1000;

export interface HostSyntheticProbeRow {
  id: string;
  name?: string | null;
  metadata?: any;
}

/** Running hosts of this bay that run synthetic probes. */
export async function listHostSyntheticProbes(): Promise<
  HostSyntheticProbeRow[]
> {
  const { rows } = await getPool().query<HostSyntheticProbeRow>(
    `
      SELECT id, name,
             jsonb_build_object(
               'runtime_synthetic_probe', metadata->'runtime_synthetic_probe'
             ) AS metadata
        FROM project_hosts
       WHERE deleted IS NULL
         AND status='running'
         AND COALESCE(NULLIF(BTRIM(bay_id), ''), $1)=$1
         AND metadata #>> '{runtime_health,synthetic_probe_supported}' = 'true'
       ORDER BY name, id
       LIMIT 1000
    `,
    [getConfiguredBayId()],
  );
  return rows;
}

type HostProbeState =
  | { kind: "passing" }
  | { kind: "failing"; detail: string }
  | { kind: "overdue"; detail: string };

function timestampMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}`).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function hostProbeState(
  row: HostSyntheticProbeRow,
  now: number,
  overdueAfterMs: number,
): HostProbeState {
  const probe = row.metadata?.runtime_synthetic_probe ?? {};
  const status = `${probe.status ?? ""}`.trim();
  if (probe.quarantined === true || status === "failed") {
    const failures = Number(probe.consecutive_failures) || 0;
    const error = `${probe.error ?? ""}`.trim();
    return {
      kind: "failing",
      detail: `failed${failures > 0 ? ` ${failures} time${failures === 1 ? "" : "s"} in a row` : ""}${probe.quarantined === true ? ", quarantined from placement" : ""}${error ? `: ${error.slice(0, 200)}` : ""}`,
    };
  }
  if (status === "running") {
    // (a probe in progress replaces the previous result)
    const claimedAt = timestampMs(probe.claimed_at);
    if (claimedAt != null && now - claimedAt <= overdueAfterMs) {
      return { kind: "passing" };
    }
    return {
      kind: "overdue",
      detail:
        claimedAt == null
          ? "a probe is running with no start time"
          : `a probe has been running for ${minutes(now - claimedAt)}`,
    };
  }
  const checkedAt = timestampMs(probe.checked_at);
  if (status === "passed" && checkedAt != null) {
    if (now - checkedAt <= overdueAfterMs) return { kind: "passing" };
    return {
      kind: "overdue",
      detail: `last passed ${minutes(now - checkedAt)} ago`,
    };
  }
  return { kind: "overdue", detail: "no synthetic probe result yet" };
}

function hostLabel(row: HostSyntheticProbeRow): string {
  return row.name ? `${row.name} (${row.id})` : row.id;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function syntheticSmokeHealth({
  smoke,
  smokeError,
  hosts,
  hostsError,
  now = Date.now(),
  overdueAfterMs = syntheticProbeOverdueAfterMs(),
}: {
  smoke?: LaunchSmokeResult | null;
  smokeError?: unknown;
  hosts?: HostSyntheticProbeRow[];
  hostsError?: unknown;
  now?: number;
  overdueAfterMs?: number;
}): { level: LaunchHealthLevel; summary: string; details: string[] } {
  const details: string[] = [];
  const parts: string[] = [];

  let smokeCurrent = false;
  let smokeFailedRecently = false;
  if (smokeError != null) {
    details.push(`Admin smoke: unable to read the latest result: ${smokeError}`);
  } else if (smoke != null) {
    const finishedAt = Date.parse(smoke.finished_at);
    const recent =
      Number.isFinite(finishedAt) && now - finishedAt <= ADMIN_SMOKE_FRESH_MS;
    smokeCurrent = recent && smoke.status === "succeeded";
    smokeFailedRecently = recent && smoke.status !== "succeeded";
    parts.push(
      `Admin smoke ${smoke.status} ${formatDuration(smoke.duration_ms)} on project ${smoke.project_id} at ${new Date(smoke.finished_at).toLocaleString()}${recent ? "" : " (older than 1 hour)"}.`,
    );
    details.push(
      ...smoke.steps.map(
        (step) =>
          `Admin smoke ${step.label}: ${step.status} in ${formatDuration(step.duration_ms)} (${step.summary})`,
      ),
    );
  } else {
    parts.push("No admin smoke result has been recorded.");
  }

  const failing: string[] = [];
  const overdue: string[] = [];
  let passing = 0;
  if (hostsError != null) {
    details.push(`Host probes: unable to read: ${hostsError}`);
  } else {
    for (const row of hosts ?? []) {
      const state = hostProbeState(row, now, overdueAfterMs);
      if (state.kind === "passing") passing += 1;
      else if (state.kind === "failing")
        failing.push(`${hostLabel(row)}: ${state.detail}`);
      else overdue.push(`${hostLabel(row)}: ${state.detail}`);
    }
    const total = passing + failing.length + overdue.length;
    parts.push(
      total === 0
        ? "No running host runs synthetic probes."
        : `Host probes: ${passing}/${total} passing${failing.length ? `, ${failing.length} failing` : ""}${overdue.length ? `, ${overdue.length} overdue (none within ${minutes(overdueAfterMs)})` : ""}.`,
    );
    details.unshift(
      ...failing.map((line) => `Host probe failing: ${line}`),
      ...overdue.map((line) => `Host probe overdue: ${line}`),
    );
  }
  const hostsAllPassing =
    hostsError == null &&
    passing > 0 &&
    failing.length === 0 &&
    overdue.length === 0;

  let level: LaunchHealthLevel;
  if (failing.length > 0 || smokeFailedRecently) {
    level = "critical";
  } else if (smokeCurrent || hostsAllPassing) {
    level = "healthy";
  } else if (smokeError != null && hostsError != null) {
    level = "critical";
  } else if (overdue.length > 0 || smoke != null) {
    level = "warning";
  } else {
    level = "unknown";
  }
  return { level, summary: parts.join(" "), details };
}
