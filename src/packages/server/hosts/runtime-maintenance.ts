/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";
import { getSitePublicOrigin } from "@cocalc/server/bay-public-origin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { enqueueCloudVmWorkOnce } from "@cocalc/server/cloud/db";
import { getExplicitHostControlClient } from "@cocalc/server/conat/route-client";
import adminAlert from "@cocalc/server/messages/admin-alert";
import {
  probeProjectHostPublicRoute,
  type ProjectHostPublicRouteProbeResult,
} from "./public-route-probe";

const logger = getLogger("server:hosts:runtime-maintenance");

const HEARTBEAT_FRESH_MS = 2 * 60_000;
const SYNTHETIC_PROBE_SUCCESS_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.COCALC_HOST_SYNTHETIC_PROBE_INTERVAL_MS ?? 30 * 60_000),
);
const SYNTHETIC_PROBE_FAILURE_RETRY_MS = Math.max(
  30_000,
  Number(process.env.COCALC_HOST_SYNTHETIC_PROBE_RETRY_MS ?? 90_000),
);
const SYNTHETIC_PROBE_CLAIM_TIMEOUT_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_SYNTHETIC_PROBE_CLAIM_TIMEOUT_MS ?? 15 * 60_000,
  ),
);
const SYNTHETIC_PROBE_RPC_TIMEOUT_MS = Math.max(
  2 * 60_000,
  Number(process.env.COCALC_HOST_SYNTHETIC_PROBE_RPC_TIMEOUT_MS ?? 2 * 60_000),
);
const SYNTHETIC_PROBE_FAILURES_TO_QUARANTINE = Math.max(
  2,
  Math.floor(
    Number(process.env.COCALC_HOST_SYNTHETIC_PROBE_FAILURES_TO_QUARANTINE ?? 2),
  ) || 2,
);
const SYNTHETIC_PROBE_CONCURRENCY = Math.max(
  1,
  Math.min(
    8,
    Math.floor(
      Number(process.env.COCALC_HOST_SYNTHETIC_PROBE_CONCURRENCY ?? 2),
    ) || 2,
  ),
);
const PUBLIC_ROUTE_PROBE_SUCCESS_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_INTERVAL_MS ?? 2 * 60_000),
);
const PUBLIC_ROUTE_PROBE_FAILURE_RETRY_MS = Math.max(
  30_000,
  Number(process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_RETRY_MS ?? 60_000),
);
const PUBLIC_ROUTE_PROBE_CLAIM_TIMEOUT_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_CLAIM_TIMEOUT_MS ?? 2 * 60_000,
  ),
);
const PUBLIC_ROUTE_PROBE_REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_REQUEST_TIMEOUT_MS ?? 15_000,
  ),
);
const PUBLIC_ROUTE_PROBE_WEBSOCKET_ATTEMPTS = Math.max(
  4,
  Math.min(
    16,
    Math.floor(
      Number(
        process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_WEBSOCKET_ATTEMPTS ?? 8,
      ),
    ) || 8,
  ),
);
const PUBLIC_ROUTE_PROBE_CONCURRENCY = Math.max(
  1,
  Math.min(
    32,
    Math.floor(
      Number(process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_CONCURRENCY ?? 32),
    ) || 32,
  ),
);
const PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE = Math.max(
  2,
  Math.floor(
    Number(
      process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE ?? 2,
    ),
  ) || 2,
);
const PUBLIC_ROUTE_PROBE_SUCCESSES_TO_RECOVER = Math.max(
  2,
  Math.floor(
    Number(
      process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_SUCCESSES_TO_RECOVER ?? 2,
    ),
  ) || 2,
);
const PUBLIC_ROUTE_AUTO_REPAIR_HOST_COOLDOWN_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_AUTO_REPAIR_HOST_COOLDOWN_MS ??
      30 * 60_000,
  ),
);
const PUBLIC_ROUTE_AUTO_REPAIR_FLEET_SPACING_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_AUTO_REPAIR_FLEET_SPACING_MS ??
      5 * 60_000,
  ),
);
const PUBLIC_ROUTE_AUTO_REPAIR_CLAIM_TIMEOUT_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_AUTO_REPAIR_CLAIM_TIMEOUT_MS ??
      2 * 60_000,
  ),
);
const PUBLIC_ROUTE_AUTO_REPAIR_RPC_TIMEOUT_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_AUTO_REPAIR_RPC_TIMEOUT_MS ?? 75_000,
  ),
);
const PUBLIC_ROUTE_AUTO_REPAIR_LOCK_ID = "7089335076842275921";
const AUTO_REBOOT_WINDOW_MS = Math.max(
  60 * 60_000,
  Number(
    process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_WINDOW_MS ?? 6 * 60 * 60_000,
  ),
);
const AUTO_REBOOT_COOLDOWN_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_COOLDOWN_MS ?? 15 * 60_000,
  ),
);
const AUTO_REBOOT_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(
    5,
    Math.floor(
      Number(process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_MAX_ATTEMPTS ?? 2),
    ) || 2,
  ),
);
const AUTO_REBOOT_MIN_FAILURES = Math.max(
  2,
  Math.floor(
    Number(process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_MIN_FAILURES ?? 2),
  ) || 2,
);
const AUTO_REBOOT_DIAGNOSTIC_SETTLE_MS = Math.max(
  10_000,
  Number(
    process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_DIAGNOSTIC_SETTLE_MS ?? 30_000,
  ),
);
const AUTO_REBOOT_FLEET_SPACING_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_FLEET_SPACING_MS ?? 10 * 60_000,
  ),
);
const ERROR_LIMIT = 2000;

type RuntimeHostRow = {
  id: string;
  name?: string | null;
  public_url?: string | null;
  status?: string | null;
  last_seen?: Date | string | null;
  metadata?: Record<string, any> | null;
};

type RebootAttempt = {
  at: string;
  host_boot_id: string;
  host_session_id?: string;
  work_id?: string;
};

type AutoRebootDecision =
  | { action: "wait"; reason: string }
  | { action: "exhausted"; attempts: RebootAttempt[] }
  | { action: "reboot"; attempts: RebootAttempt[] };

type PublicRouteProbeClaim = {
  claim_id: string;
  previous_status?: string;
  previous_failures: number;
  previous_successes: number;
  was_quarantined: boolean;
  alerted_at?: string;
};

type PublicRouteFailure = {
  row: RuntimeHostRow;
  error: string;
  consecutive_failures: number;
  probe: Record<string, any>;
};

type PublicRouteAutoRepairDecision =
  | { action: "wait"; reason: string }
  | { action: "restart" };

type SyntheticProbeClaim = {
  claim_id: string;
  previous_failures: number;
  previous_total_checks: number;
  previous_passed_checks: number;
  previous_failed_checks: number;
  was_quarantined: boolean;
  alerted_at?: string;
};

const RECOVERABLE_AUTO_REBOOT_STATUSES = new Set([
  "scheduled",
  "exhausted",
  "enqueue_failed",
]);

function pool() {
  return getPool();
}

function enabled(value: string | undefined, defaultValue = true): boolean {
  if (value == null || !value.trim()) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function timestampMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}`).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorText(err: unknown): string {
  return (`${err}`.trim() || "unknown runtime probe error").slice(
    0,
    ERROR_LIMIT,
  );
}

function hostName(row: RuntimeHostRow): string {
  return `${row.name ?? row.metadata?.name ?? row.id}`.trim() || row.id;
}

function deploymentLabel(row: RuntimeHostRow): string {
  if (!row.public_url) {
    return "unknown-site";
  }
  try {
    const hostname = new URL(row.public_url).hostname;
    const hostPrefix = `host-${row.id}-`;
    return hostname.startsWith(hostPrefix)
      ? hostname.slice(hostPrefix.length)
      : hostname;
  } catch {
    return row.public_url;
  }
}

function cloudProvider(row: RuntimeHostRow): string | undefined {
  const provider = `${row.metadata?.machine?.cloud ?? ""}`.trim();
  if (!provider || provider === "local" || provider === "self-host") {
    return undefined;
  }
  return provider;
}

function syntheticProbeDue(row: RuntimeHostRow, nowMs = Date.now()): boolean {
  const probe = row.metadata?.runtime_synthetic_probe ?? {};
  const currentBootId = `${row.metadata?.host_boot_id ?? ""}`.trim();
  const probeBootId = `${probe.host_boot_id ?? ""}`.trim();
  if (!probeBootId || (currentBootId && probeBootId !== currentBootId)) {
    return true;
  }
  const currentSessionId = `${row.metadata?.host_session_id ?? ""}`.trim();
  const probeSessionId = `${probe.host_session_id ?? ""}`.trim();
  if (currentSessionId && probeSessionId !== currentSessionId) {
    return true;
  }
  const status = `${probe.status ?? ""}`.trim();
  const checkedAt = timestampMs(probe.checked_at ?? probe.claimed_at) ?? 0;
  if (status === "running") {
    return nowMs - checkedAt >= SYNTHETIC_PROBE_CLAIM_TIMEOUT_MS;
  }
  if (status === "failed") {
    const bootstrapFinishedAt = timestampMs(
      row.metadata?.bootstrap_lifecycle?.last_reconcile_finished_at,
    );
    if (bootstrapFinishedAt != null && bootstrapFinishedAt > checkedAt) {
      return true;
    }
    return nowMs - checkedAt >= SYNTHETIC_PROBE_FAILURE_RETRY_MS;
  }
  return nowMs - checkedAt >= SYNTHETIC_PROBE_SUCCESS_INTERVAL_MS;
}

function syntheticProbeFailureAlertDue(row: RuntimeHostRow): boolean {
  return timestampMs(row.metadata?.runtime_synthetic_probe?.alerted_at) == null;
}

function syntheticProbeOutcome({
  row,
  claim,
  checkedAt,
  duration_ms,
  result,
  error,
  alerted_at,
}: {
  row: RuntimeHostRow;
  claim: SyntheticProbeClaim;
  checkedAt: string;
  duration_ms: number;
  result?: Record<string, any>;
  error?: unknown;
  alerted_at?: string;
}): Record<string, any> {
  const failed = error != null;
  const consecutiveFailures = failed ? claim.previous_failures + 1 : 0;
  const quarantined =
    failed &&
    (claim.was_quarantined ||
      consecutiveFailures >= SYNTHETIC_PROBE_FAILURES_TO_QUARANTINE);
  return {
    status: failed ? "failed" : "passed",
    claim_id: claim.claim_id,
    checked_at: checkedAt,
    host_boot_id: row.metadata?.host_boot_id,
    host_session_id: row.metadata?.host_session_id,
    duration_ms,
    consecutive_failures: consecutiveFailures,
    total_checks: claim.previous_total_checks + 1,
    passed_checks: claim.previous_passed_checks + (failed ? 0 : 1),
    failed_checks: claim.previous_failed_checks + (failed ? 1 : 0),
    quarantined,
    error: failed ? errorText(error) : undefined,
    result: failed ? undefined : result,
    alerted_at: quarantined ? (alerted_at ?? claim.alerted_at) : undefined,
  };
}

function publicRouteProbeDue(row: RuntimeHostRow, nowMs = Date.now()): boolean {
  const probe = row.metadata?.public_route_probe ?? {};
  const currentBootId = `${row.metadata?.host_boot_id ?? ""}`.trim();
  const probeBootId = `${probe.host_boot_id ?? ""}`.trim();
  if (!probeBootId || (currentBootId && probeBootId !== currentBootId)) {
    return true;
  }
  const currentSessionId = `${row.metadata?.host_session_id ?? ""}`.trim();
  const probeSessionId = `${probe.host_session_id ?? ""}`.trim();
  if (currentSessionId && probeSessionId !== currentSessionId) {
    return true;
  }
  const status = `${probe.status ?? ""}`.trim();
  const checkedAt = timestampMs(probe.checked_at ?? probe.claimed_at) ?? 0;
  if (status === "running") {
    return nowMs - checkedAt >= PUBLIC_ROUTE_PROBE_CLAIM_TIMEOUT_MS;
  }
  if (status === "failed" || status === "recovering") {
    return nowMs - checkedAt >= PUBLIC_ROUTE_PROBE_FAILURE_RETRY_MS;
  }
  return nowMs - checkedAt >= PUBLIC_ROUTE_PROBE_SUCCESS_INTERVAL_MS;
}

function publicRouteProbeFailureAlertDue(row: RuntimeHostRow): boolean {
  return timestampMs(row.metadata?.public_route_probe?.alerted_at) == null;
}

function publicRouteProbeOutcome({
  row,
  claim,
  checkedAt,
  duration_ms,
  result,
  error,
  alerted_at,
}: {
  row: RuntimeHostRow;
  claim: PublicRouteProbeClaim;
  checkedAt: string;
  duration_ms: number;
  result?: ProjectHostPublicRouteProbeResult;
  error?: unknown;
  alerted_at?: string;
}): Record<string, any> {
  const failed = error != null;
  const consecutiveFailures = failed ? claim.previous_failures + 1 : 0;
  const consecutiveSuccesses = failed ? 0 : claim.previous_successes + 1;
  const quarantined = failed
    ? claim.was_quarantined ||
      consecutiveFailures >= PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE
    : claim.was_quarantined &&
      consecutiveSuccesses < PUBLIC_ROUTE_PROBE_SUCCESSES_TO_RECOVER;
  return {
    status: failed ? "failed" : quarantined ? "recovering" : "passed",
    claim_id: claim.claim_id,
    checked_at: checkedAt,
    host_boot_id: row.metadata?.host_boot_id,
    host_session_id: row.metadata?.host_session_id,
    duration_ms,
    consecutive_failures: consecutiveFailures,
    consecutive_successes: consecutiveSuccesses,
    quarantined,
    error: failed ? errorText(error) : undefined,
    result: failed ? undefined : result,
    alerted_at: failed
      ? (alerted_at ?? claim.alerted_at)
      : quarantined
        ? claim.alerted_at
        : undefined,
  };
}

function publicRouteAutoRepairDecision(
  row: RuntimeHostRow,
  probe: Record<string, any>,
  nowMs = Date.now(),
): PublicRouteAutoRepairDecision {
  if (!enabled(process.env.COCALC_HOST_PUBLIC_ROUTE_AUTO_REPAIR_ENABLED)) {
    return { action: "wait", reason: "automatic tunnel repair is disabled" };
  }
  if (row.metadata?.cloudflared_restart_supported !== true) {
    return {
      action: "wait",
      reason: "host does not advertise tunnel restart support",
    };
  }
  if (probe.quarantined !== true) {
    return { action: "wait", reason: "public route is not quarantined" };
  }
  if (
    (Number(probe.consecutive_failures) || 0) <
    PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE
  ) {
    return { action: "wait", reason: "failure threshold is not met" };
  }
  const recovery = row.metadata?.public_route_auto_recovery ?? {};
  const attemptedAt = timestampMs(recovery.attempted_at);
  if (
    attemptedAt != null &&
    nowMs - attemptedAt < PUBLIC_ROUTE_AUTO_REPAIR_HOST_COOLDOWN_MS
  ) {
    return { action: "wait", reason: "host tunnel repair is in cooldown" };
  }
  const claimExpiresAt = timestampMs(recovery.claim_expires_at);
  if (
    `${recovery.status ?? ""}` === "claiming" &&
    claimExpiresAt != null &&
    claimExpiresAt > nowMs
  ) {
    return { action: "wait", reason: "host tunnel repair is already claimed" };
  }
  return { action: "restart" };
}

function recentRebootAttempts(metadata: any, nowMs: number): RebootAttempt[] {
  const attempts = Array.isArray(metadata?.runtime_auto_recovery?.attempts)
    ? metadata.runtime_auto_recovery.attempts
    : [];
  return attempts.filter((attempt: any) => {
    const at = timestampMs(attempt?.at);
    return at != null && nowMs - at < AUTO_REBOOT_WINDOW_MS;
  });
}

function recoveredAutoRebootState(
  row: RuntimeHostRow,
  nowMs = Date.now(),
): Record<string, any> | undefined {
  const current = row.metadata?.runtime_auto_recovery ?? {};
  const status = `${current.status ?? ""}`.trim();
  const currentBootId = `${row.metadata?.host_boot_id ?? ""}`.trim();
  const recoveryBootId = `${current.host_boot_id ?? ""}`.trim();
  if (
    !RECOVERABLE_AUTO_REBOOT_STATUSES.has(status) ||
    !currentBootId ||
    !recoveryBootId ||
    currentBootId === recoveryBootId
  ) {
    return undefined;
  }
  return {
    status: "recovered",
    recovered_at: new Date(nowMs).toISOString(),
    host_boot_id: currentBootId,
    host_session_id: row.metadata?.host_session_id,
    previous_status: status,
    previous_host_boot_id: recoveryBootId,
    work_id: current.work_id,
    cooldown_until: current.cooldown_until,
    attempts: recentRebootAttempts(row.metadata, nowMs),
  };
}

function autoRebootDecision(
  row: RuntimeHostRow,
  nowMs = Date.now(),
): AutoRebootDecision {
  if (!enabled(process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_ENABLED)) {
    return { action: "wait", reason: "automatic reboot is disabled" };
  }
  if (!cloudProvider(row)) {
    return { action: "wait", reason: "host is not cloud-backed" };
  }
  if (`${row.status ?? ""}`.trim() !== "running") {
    return { action: "wait", reason: "host is not running" };
  }
  const lastSeen = timestampMs(row.last_seen);
  if (lastSeen == null || nowMs - lastSeen > HEARTBEAT_FRESH_MS) {
    return { action: "wait", reason: "host heartbeat is stale" };
  }
  if (`${row.metadata?.desired_state ?? "running"}` !== "running") {
    return { action: "wait", reason: "host is not desired running" };
  }
  const runtime = row.metadata?.runtime_health ?? {};
  if (`${runtime.status ?? ""}` !== "degraded" || runtime.ready === true) {
    return { action: "wait", reason: "runtime is not degraded" };
  }
  const runtimeFailures = Number(runtime.consecutive_failures) || 0;
  if (runtimeFailures < AUTO_REBOOT_MIN_FAILURES) {
    return {
      action: "wait",
      reason: "passive runtime failure threshold is not met",
    };
  }
  const diagnosticsCompletedAt = timestampMs(runtime.diagnostics_completed_at);
  if (diagnosticsCompletedAt == null) {
    return { action: "wait", reason: "forensic capture is not complete" };
  }
  if (nowMs - diagnosticsCompletedAt < AUTO_REBOOT_DIAGNOSTIC_SETTLE_MS) {
    return { action: "wait", reason: "forensic capture is still settling" };
  }
  const current = row.metadata?.runtime_auto_recovery ?? {};
  const cooldownUntil = timestampMs(current.cooldown_until);
  if (cooldownUntil != null && cooldownUntil > nowMs) {
    return { action: "wait", reason: "automatic reboot is in cooldown" };
  }
  const claimExpiresAt = timestampMs(current.claim_expires_at);
  if (
    `${current.status ?? ""}` === "claiming" &&
    claimExpiresAt != null &&
    claimExpiresAt > nowMs
  ) {
    return { action: "wait", reason: "automatic reboot is already claimed" };
  }
  const attempts = recentRebootAttempts(row.metadata, nowMs);
  if (attempts.length >= AUTO_REBOOT_MAX_ATTEMPTS) {
    return { action: "exhausted", attempts };
  }
  return { action: "reboot", attempts };
}

async function listRuntimeHosts(): Promise<RuntimeHostRow[]> {
  const { rows } = await pool().query<RuntimeHostRow>(
    `
      SELECT id, name, public_url, status, last_seen, metadata
      FROM project_hosts
      WHERE deleted IS NULL
        AND status='running'
        AND COALESCE(NULLIF(BTRIM(bay_id), ''), $1)=$1
        AND COALESCE(last_seen, to_timestamp(0)) >=
          NOW() - ($2::double precision * INTERVAL '1 millisecond')
      ORDER BY last_seen DESC
      LIMIT 1000
    `,
    [getConfiguredBayId(), HEARTBEAT_FRESH_MS],
  );
  return rows;
}

async function claimSyntheticProbe(
  row: RuntimeHostRow,
): Promise<SyntheticProbeClaim | undefined> {
  const claimId = randomUUID();
  const previous = row.metadata?.runtime_synthetic_probe ?? {};
  const sameSession =
    `${previous.host_session_id ?? ""}`.trim() ===
    `${row.metadata?.host_session_id ?? ""}`.trim();
  const previousFailures = sameSession
    ? Number(previous.consecutive_failures) || 0
    : 0;
  const claim: SyntheticProbeClaim = {
    claim_id: claimId,
    previous_failures: previousFailures,
    previous_total_checks: sameSession ? Number(previous.total_checks) || 0 : 0,
    previous_passed_checks: sameSession
      ? Number(previous.passed_checks) || 0
      : 0,
    previous_failed_checks: sameSession
      ? Number(previous.failed_checks) || 0
      : 0,
    was_quarantined: sameSession && previous.quarantined === true,
    alerted_at:
      sameSession && `${previous.alerted_at ?? ""}`.trim()
        ? `${previous.alerted_at}`.trim()
        : undefined,
  };
  const probe = {
    status: "running",
    claim_id: claimId,
    claimed_at: new Date().toISOString(),
    host_boot_id: row.metadata?.host_boot_id,
    host_session_id: row.metadata?.host_session_id,
    consecutive_failures: previousFailures,
    total_checks: claim.previous_total_checks,
    passed_checks: claim.previous_passed_checks,
    failed_checks: claim.previous_failed_checks,
    quarantined: claim.was_quarantined,
    alerted_at: claim.alerted_at,
  };
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{runtime_synthetic_probe}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND status='running'
        AND COALESCE(last_seen, to_timestamp(0)) >=
          NOW() - ($2::double precision * INTERVAL '1 millisecond')
        AND (
          metadata -> 'runtime_synthetic_probe' ->> 'status' IS DISTINCT FROM 'running'
          OR COALESCE(
            (metadata -> 'runtime_synthetic_probe' ->> 'claimed_at')::timestamptz,
            to_timestamp(0)
          ) < NOW() - ($4::double precision * INTERVAL '1 millisecond')
        )
    `,
    [
      row.id,
      HEARTBEAT_FRESH_MS,
      JSON.stringify(probe),
      SYNTHETIC_PROBE_CLAIM_TIMEOUT_MS,
    ],
  );
  return rowCount ? claim : undefined;
}

async function finishSyntheticProbe({
  row,
  claim,
  startedAt,
  error,
  result,
  alerted_at,
}: {
  row: RuntimeHostRow;
  claim: SyntheticProbeClaim;
  startedAt: number;
  error?: unknown;
  result?: Record<string, any>;
  alerted_at?: string;
}): Promise<Record<string, any>> {
  const probe = syntheticProbeOutcome({
    row,
    claim,
    checkedAt: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    error,
    result,
    alerted_at,
  });
  await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{runtime_synthetic_probe}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND metadata -> 'runtime_synthetic_probe' ->> 'claim_id'=$2
    `,
    [row.id, claim.claim_id, JSON.stringify(probe)],
  );
  return probe;
}

async function markAutoRebootRecovered(row: RuntimeHostRow): Promise<void> {
  const state = recoveredAutoRebootState(row);
  if (!state) return;
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{runtime_auto_recovery}',
        $4::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND metadata ->> 'host_boot_id'=$2
        AND metadata -> 'runtime_auto_recovery' ->> 'host_boot_id'=$3
        AND metadata -> 'runtime_auto_recovery' ->> 'status' = ANY($5::text[])
    `,
    [
      row.id,
      row.metadata?.host_boot_id,
      row.metadata?.runtime_auto_recovery?.host_boot_id,
      JSON.stringify(state),
      Array.from(RECOVERABLE_AUTO_REBOOT_STATUSES),
    ],
  );
  if (rowCount) {
    logger.info("project-host automatic reboot recovery completed", {
      host_id: row.id,
      host_name: hostName(row),
      previous_status: state.previous_status,
      previous_host_boot_id: state.previous_host_boot_id,
      host_boot_id: state.host_boot_id,
    });
  }
}

async function executeSyntheticProbe(
  row: RuntimeHostRow,
  claim: SyntheticProbeClaim,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const client = createHostControlClient({
      host_id: row.id,
      client: await getExplicitHostControlClient({
        host_id: row.id,
        fresh: true,
      }),
      timeout: SYNTHETIC_PROBE_RPC_TIMEOUT_MS,
    });
    if (typeof client.runSyntheticRuntimeProbe !== "function") {
      throw new Error("host does not support synthetic runtime probes");
    }
    const result = await client.runSyntheticRuntimeProbe();
    await finishSyntheticProbe({
      row,
      claim,
      startedAt,
      result,
    });
    await markAutoRebootRecovered(row).catch((err) => {
      logger.warn("unable to mark project-host automatic reboot as recovered", {
        host_id: row.id,
        host_name: hostName(row),
        err: errorText(err),
      });
    });
    logger.info("project-host synthetic runtime probe passed", {
      host_id: row.id,
      host_name: hostName(row),
      duration_ms: Date.now() - startedAt,
    });
    return true;
  } catch (err) {
    const willQuarantine =
      claim.was_quarantined ||
      claim.previous_failures + 1 >= SYNTHETIC_PROBE_FAILURES_TO_QUARANTINE;
    const alertDue = willQuarantine && syntheticProbeFailureAlertDue(row);
    const probe = await finishSyntheticProbe({
      row,
      claim,
      startedAt,
      error: err,
      alerted_at: alertDue ? new Date().toISOString() : undefined,
    });
    logger.warn("project-host synthetic runtime probe failed", {
      host_id: row.id,
      host_name: hostName(row),
      duration_ms: Date.now() - startedAt,
      err: errorText(err),
    });
    if (alertDue) {
      const site = deploymentLabel(row);
      await adminAlert({
        subject: `[${site}] Project-host synthetic probe failed: ${hostName(row)}`,
        body: [
          `A full synthetic project lifecycle probe failed on ${hostName(row)}.`,
          `site=${site}`,
          `host_id=${row.id}`,
          `consecutive_failures=${probe.consecutive_failures}`,
          `error=${errorText(err)}`,
          row.public_url ? `url=${row.public_url}` : undefined,
          "The host is quarantined from placement until a later probe succeeds.",
        ]
          .filter(Boolean)
          .join("\n"),
        dedupMinutes: 15,
        dedupBySubject: true,
      });
    }
    return false;
  }
}

export async function runSyntheticProjectHostProbes(): Promise<{
  attempted: number;
  passed: number;
  failed: number;
}> {
  if (!enabled(process.env.COCALC_HOST_SYNTHETIC_PROBES_ENABLED)) {
    return { attempted: 0, passed: 0, failed: 0 };
  }
  const rows = (await listRuntimeHosts())
    .filter((row) => {
      const runtime = row.metadata?.runtime_health ?? {};
      const passiveRuntimeReady =
        runtime.ready === true ||
        (runtime.status === "degraded" &&
          Number(runtime.consecutive_failures) === 0 &&
          runtime.synthetic_probe?.status === "failed");
      return (
        passiveRuntimeReady &&
        runtime.synthetic_probe_supported === true &&
        !["queued", "running"].includes(
          `${row.metadata?.host_restart_recovery?.status ?? ""}`,
        ) &&
        syntheticProbeDue(row)
      );
    })
    .slice(0, SYNTHETIC_PROBE_CONCURRENCY);
  const claimed = (
    await Promise.all(
      rows.map(async (row) => ({ row, claim: await claimSyntheticProbe(row) })),
    )
  ).filter(
    (
      entry,
    ): entry is {
      row: RuntimeHostRow;
      claim: SyntheticProbeClaim;
    } => entry.claim != null,
  );
  const results = await Promise.all(
    claimed.map(({ row, claim }) => executeSyntheticProbe(row, claim)),
  );
  const passed = results.filter(Boolean).length;
  return {
    attempted: results.length,
    passed,
    failed: results.length - passed,
  };
}

async function claimPublicRouteProbe(
  row: RuntimeHostRow,
): Promise<PublicRouteProbeClaim | undefined> {
  const claimId = randomUUID();
  const previous = row.metadata?.public_route_probe ?? {};
  const claim: PublicRouteProbeClaim = {
    claim_id: claimId,
    previous_status: `${previous.status ?? ""}`.trim() || undefined,
    previous_failures: Number(previous.consecutive_failures) || 0,
    previous_successes: Number(previous.consecutive_successes) || 0,
    was_quarantined: previous.quarantined === true,
    alerted_at: `${previous.alerted_at ?? ""}`.trim() || undefined,
  };
  const probe = {
    status: "running",
    claim_id: claimId,
    claimed_at: new Date().toISOString(),
    host_boot_id: row.metadata?.host_boot_id,
    host_session_id: row.metadata?.host_session_id,
    consecutive_failures: claim.previous_failures,
    consecutive_successes: claim.previous_successes,
    quarantined: claim.was_quarantined,
    alerted_at: claim.alerted_at,
  };
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{public_route_probe}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND status='running'
        AND COALESCE(last_seen, to_timestamp(0)) >=
          NOW() - ($2::double precision * INTERVAL '1 millisecond')
        AND (
          metadata -> 'public_route_probe' ->> 'status' IS DISTINCT FROM 'running'
          OR COALESCE(
            (metadata -> 'public_route_probe' ->> 'claimed_at')::timestamptz,
            to_timestamp(0)
          ) < NOW() - ($4::double precision * INTERVAL '1 millisecond')
        )
    `,
    [
      row.id,
      HEARTBEAT_FRESH_MS,
      JSON.stringify(probe),
      PUBLIC_ROUTE_PROBE_CLAIM_TIMEOUT_MS,
    ],
  );
  return rowCount ? claim : undefined;
}

async function finishPublicRouteProbe({
  row,
  claim,
  startedAt,
  result,
  error,
  alerted_at,
}: {
  row: RuntimeHostRow;
  claim: PublicRouteProbeClaim;
  startedAt: number;
  result?: ProjectHostPublicRouteProbeResult;
  error?: unknown;
  alerted_at?: string;
}): Promise<Record<string, any>> {
  const probe = publicRouteProbeOutcome({
    row,
    claim,
    checkedAt: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    result,
    error,
    alerted_at,
  });
  await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{public_route_probe}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND metadata -> 'public_route_probe' ->> 'claim_id'=$2
    `,
    [row.id, claim.claim_id, JSON.stringify(probe)],
  );
  return probe;
}

async function executePublicRouteProbe({
  row,
  claim,
  origin,
}: {
  row: RuntimeHostRow;
  claim: PublicRouteProbeClaim;
  origin: string;
}): Promise<{
  passed: boolean;
  quarantined: boolean;
  recovered: boolean;
  failure?: PublicRouteFailure;
  alert?: { row: RuntimeHostRow; error: string; consecutive_failures: number };
}> {
  const startedAt = Date.now();
  try {
    const result = await probeProjectHostPublicRoute({
      public_url: `${row.public_url}`,
      origin,
      timeout_ms: PUBLIC_ROUTE_PROBE_REQUEST_TIMEOUT_MS,
      websocket_attempts: PUBLIC_ROUTE_PROBE_WEBSOCKET_ATTEMPTS,
    });
    const probe = await finishPublicRouteProbe({
      row,
      claim,
      startedAt,
      result,
    });
    logger.info("project-host public route probe passed", {
      host_id: row.id,
      host_name: hostName(row),
      duration_ms: Date.now() - startedAt,
      recovery_status: probe.status,
      consecutive_successes: probe.consecutive_successes,
    });
    return {
      passed: true,
      quarantined: probe.quarantined === true,
      recovered: claim.was_quarantined && probe.quarantined !== true,
    };
  } catch (err) {
    const nextFailures = claim.previous_failures + 1;
    const willQuarantine =
      claim.was_quarantined ||
      nextFailures >= PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE;
    const alertDue = willQuarantine && publicRouteProbeFailureAlertDue(row);
    const probe = await finishPublicRouteProbe({
      row,
      claim,
      startedAt,
      error: err,
      alerted_at: alertDue ? new Date().toISOString() : undefined,
    });
    logger.warn("project-host public route probe failed", {
      host_id: row.id,
      host_name: hostName(row),
      duration_ms: Date.now() - startedAt,
      consecutive_failures: probe.consecutive_failures,
      quarantined: probe.quarantined,
      err: errorText(err),
    });
    return {
      passed: false,
      quarantined: probe.quarantined === true,
      recovered: false,
      failure: {
        row,
        error: errorText(err),
        consecutive_failures: probe.consecutive_failures,
        probe,
      },
      alert: alertDue
        ? {
            row,
            error: errorText(err),
            consecutive_failures: probe.consecutive_failures,
          }
        : undefined,
    };
  }
}

async function alertPublicRouteFailures({
  origin,
  failures,
}: {
  origin: string;
  failures: Array<{
    row: RuntimeHostRow;
    error: string;
    consecutive_failures: number;
  }>;
}): Promise<void> {
  if (!failures.length) return;
  const sites = Array.from(
    new Set(failures.map(({ row }) => deploymentLabel(row))),
  ).join(",");
  await adminAlert({
    subject: `[${sites}] ${failures.length} project-host public route${failures.length === 1 ? "" : "s"} failed`,
    body: [
      `${failures.length} public project-host browser route${failures.length === 1 ? " has" : "s have"} failed repeated probes.`,
      `site=${sites}`,
      `origin=${origin}`,
      "The hosts still have fresh backend heartbeats, but are quarantined from placement because browser CORS/session traffic may not reach them.",
      "This signal never reboots a VM or project runtime. A supported host may receive one rate-limited cloudflared restart.",
      "",
      ...failures.map(({ row, error, consecutive_failures }) =>
        [
          `${hostName(row)} host_id=${row.id}`,
          `failures=${consecutive_failures}`,
          `error=${error}`,
          row.public_url ? `url=${row.public_url}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ].join("\n"),
    dedupMinutes: 15,
    dedupBySubject: true,
  });
}

async function alertPublicRouteRecoveries(
  rows: RuntimeHostRow[],
): Promise<void> {
  if (!rows.length) return;
  const sites = Array.from(new Set(rows.map(deploymentLabel))).join(",");
  await adminAlert({
    subject: `[${sites}] ${rows.length} project-host public route${rows.length === 1 ? "" : "s"} recovered`,
    body: [
      `${rows.length} public project-host browser route${rows.length === 1 ? " has" : "s have"} passed two consecutive recovery probes and returned to placement.`,
      ...rows.map(
        (row) => `${hostName(row)} host_id=${row.id} url=${row.public_url}`,
      ),
    ].join("\n"),
    dedupMinutes: 15,
  });
}

async function claimPublicRouteAutoRepair(
  failure: PublicRouteFailure,
): Promise<string | undefined> {
  const claimId = randomUUID();
  const now = Date.now();
  const state = {
    status: "claiming",
    claim_id: claimId,
    claimed_at: new Date(now).toISOString(),
    attempted_at: new Date(now).toISOString(),
    claim_expires_at: new Date(
      now + PUBLIC_ROUTE_AUTO_REPAIR_CLAIM_TIMEOUT_MS,
    ).toISOString(),
    probe_claim_id: failure.probe.claim_id,
    consecutive_failures: failure.consecutive_failures,
    trigger_error: failure.error,
  };
  const { rowCount } = await pool().query(
    `
      WITH fleet_lock AS (
        SELECT pg_try_advisory_xact_lock($8::bigint) AS acquired
      )
      UPDATE project_hosts AS target
      SET metadata=jsonb_set(
        COALESCE(target.metadata, '{}'::jsonb),
        '{public_route_auto_recovery}',
        $3::jsonb,
        true
      ), updated=NOW()
      FROM fleet_lock
      WHERE fleet_lock.acquired
        AND target.id=$1
        AND target.deleted IS NULL
        AND target.status='running'
        AND COALESCE(NULLIF(BTRIM(target.bay_id), ''), $2)=$2
        AND COALESCE(target.last_seen, to_timestamp(0)) >=
          NOW() - ($5::double precision * INTERVAL '1 millisecond')
        AND target.metadata ->> 'cloudflared_restart_supported'='true'
        AND target.metadata -> 'public_route_probe' ->> 'claim_id'=$4
        AND target.metadata -> 'public_route_probe' ->> 'quarantined'='true'
        AND COALESCE(
          (target.metadata -> 'public_route_probe' ->> 'consecutive_failures')::integer,
          0
        ) >= $6
        AND COALESCE(
          NULLIF(
            target.metadata -> 'public_route_auto_recovery' ->> 'attempted_at',
            ''
          )::timestamptz,
          to_timestamp(0)
        ) < NOW() - ($7::double precision * INTERVAL '1 millisecond')
        AND NOT EXISTS (
          SELECT 1
          FROM project_hosts AS recent
          WHERE recent.deleted IS NULL
            AND COALESCE(NULLIF(BTRIM(recent.bay_id), ''), $2)=$2
            AND COALESCE(
              NULLIF(
                recent.metadata -> 'public_route_auto_recovery' ->> 'attempted_at',
                ''
              )::timestamptz,
              to_timestamp(0)
            ) >= NOW() - ($9::double precision * INTERVAL '1 millisecond')
        )
    `,
    [
      failure.row.id,
      getConfiguredBayId(),
      JSON.stringify(state),
      failure.probe.claim_id,
      HEARTBEAT_FRESH_MS,
      PUBLIC_ROUTE_PROBE_FAILURES_TO_QUARANTINE,
      PUBLIC_ROUTE_AUTO_REPAIR_HOST_COOLDOWN_MS,
      PUBLIC_ROUTE_AUTO_REPAIR_LOCK_ID,
      PUBLIC_ROUTE_AUTO_REPAIR_FLEET_SPACING_MS,
    ],
  );
  return rowCount ? claimId : undefined;
}

async function updatePublicRouteAutoRecovery({
  host_id,
  claim_id,
  state,
}: {
  host_id: string;
  claim_id: string;
  state: Record<string, any>;
}): Promise<void> {
  await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{public_route_auto_recovery}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND metadata -> 'public_route_auto_recovery' ->> 'claim_id'=$2
    `,
    [host_id, claim_id, JSON.stringify(state)],
  );
}

async function executePublicRouteAutoRepair({
  failure,
  claim_id,
}: {
  failure: PublicRouteFailure;
  claim_id: string;
}): Promise<boolean> {
  const attemptedAt = new Date().toISOString();
  let result: Awaited<
    ReturnType<ReturnType<typeof createHostControlClient>["restartCloudflared"]>
  >;
  try {
    const client = createHostControlClient({
      host_id: failure.row.id,
      client: await getExplicitHostControlClient({
        host_id: failure.row.id,
        fresh: true,
      }),
      timeout: PUBLIC_ROUTE_AUTO_REPAIR_RPC_TIMEOUT_MS,
    });
    result = await client.restartCloudflared({
      reason: "public-route-probe",
      claim_id,
    });
  } catch (err) {
    await updatePublicRouteAutoRecovery({
      host_id: failure.row.id,
      claim_id,
      state: {
        status: "restart_failed",
        claim_id,
        attempted_at: attemptedAt,
        failed_at: new Date().toISOString(),
        probe_claim_id: failure.probe.claim_id,
        consecutive_failures: failure.consecutive_failures,
        trigger_error: failure.error,
        error: errorText(err),
      },
    }).catch((metadataErr) => {
      logger.error("unable to record failed cloudflared restart", {
        host_id: failure.row.id,
        claim_id,
        err: errorText(metadataErr),
      });
    });
    logger.error("automatic cloudflared restart failed", {
      host_id: failure.row.id,
      host_name: hostName(failure.row),
      claim_id,
      err: errorText(err),
    });
    await adminAlert({
      subject: `Automatic project-host tunnel restart failed: ${hostName(failure.row)}`,
      body: [
        `CoCalc could not restart cloudflared on ${hostName(failure.row)} after repeated browser route failures.`,
        `host_id=${failure.row.id}`,
        `claim_id=${claim_id}`,
        `error=${errorText(err)}`,
        "The host remains quarantined and requires operator investigation.",
      ].join("\n"),
      dedupMinutes: 15,
    }).catch((alertErr) => {
      logger.error("unable to alert failed cloudflared restart", {
        host_id: failure.row.id,
        claim_id,
        err: errorText(alertErr),
      });
    });
    return false;
  }

  await updatePublicRouteAutoRecovery({
    host_id: failure.row.id,
    claim_id,
    state: {
      status: "restart_completed",
      claim_id,
      attempted_at: attemptedAt,
      completed_at: new Date().toISOString(),
      probe_claim_id: failure.probe.claim_id,
      consecutive_failures: failure.consecutive_failures,
      trigger_error: failure.error,
      result,
    },
  }).catch((err) => {
    logger.error("unable to record completed cloudflared restart", {
      host_id: failure.row.id,
      claim_id,
      err: errorText(err),
    });
  });
  logger.error("automatically restarted cloudflared for failed public route", {
    host_id: failure.row.id,
    host_name: hostName(failure.row),
    claim_id,
    consecutive_failures: failure.consecutive_failures,
    duration_ms: result.duration_ms,
  });
  await adminAlert({
    subject: `Automatically restarted project-host tunnel: ${hostName(failure.row)}`,
    body: [
      `CoCalc restarted cloudflared on ${hostName(failure.row)} after repeated browser WebSocket route failures.`,
      `host_id=${failure.row.id}`,
      `claim_id=${claim_id}`,
      `consecutive_failures=${failure.consecutive_failures}`,
      `restart_duration_ms=${result.duration_ms}`,
      `trigger_error=${failure.error}`,
      "The host remains quarantined until two subsequent public route probes pass.",
    ].join("\n"),
    dedupMinutes: 15,
  }).catch((err) => {
    logger.error("unable to alert completed cloudflared restart", {
      host_id: failure.row.id,
      claim_id,
      err: errorText(err),
    });
  });
  return true;
}

async function runPublicRouteAutoRepair(
  failures: PublicRouteFailure[],
): Promise<{ attempted: number; completed: number; failed: number }> {
  for (const failure of failures) {
    const row = {
      ...failure.row,
      metadata: {
        ...(failure.row.metadata ?? {}),
        public_route_probe: failure.probe,
      },
    };
    const decision = publicRouteAutoRepairDecision(row, failure.probe);
    if (decision.action !== "restart") continue;
    const claimId = await claimPublicRouteAutoRepair(failure);
    if (!claimId) continue;
    const completed = await executePublicRouteAutoRepair({
      failure,
      claim_id: claimId,
    });
    return {
      attempted: 1,
      completed: completed ? 1 : 0,
      failed: completed ? 0 : 1,
    };
  }
  return { attempted: 0, completed: 0, failed: 0 };
}

export async function runProjectHostPublicRouteProbes(): Promise<{
  attempted: number;
  passed: number;
  failed: number;
  quarantined: number;
  repairs: { attempted: number; completed: number; failed: number };
}> {
  if (!enabled(process.env.COCALC_HOST_PUBLIC_ROUTE_PROBES_ENABLED)) {
    return {
      attempted: 0,
      passed: 0,
      failed: 0,
      quarantined: 0,
      repairs: { attempted: 0, completed: 0, failed: 0 },
    };
  }
  const origin =
    `${process.env.COCALC_HOST_PUBLIC_ROUTE_PROBE_ORIGIN ?? ""}`.trim() ||
    (await getSitePublicOrigin());
  if (!origin) {
    logger.warn("project-host public route probes have no configured origin");
    return {
      attempted: 0,
      passed: 0,
      failed: 0,
      quarantined: 0,
      repairs: { attempted: 0, completed: 0, failed: 0 },
    };
  }
  const rows = (await listRuntimeHosts())
    .filter((row) => {
      const runtime = row.metadata?.runtime_health ?? {};
      return (
        !!`${row.public_url ?? ""}`.trim() &&
        `${row.metadata?.desired_state ?? "running"}` === "running" &&
        runtime.status === "ready" &&
        runtime.ready === true &&
        !["queued", "running"].includes(
          `${row.metadata?.host_restart_recovery?.status ?? ""}`,
        ) &&
        publicRouteProbeDue(row)
      );
    })
    .slice(0, PUBLIC_ROUTE_PROBE_CONCURRENCY);
  const claimed = (
    await Promise.all(
      rows.map(async (row) => ({
        row,
        claim: await claimPublicRouteProbe(row),
      })),
    )
  ).filter(
    (
      entry,
    ): entry is {
      row: RuntimeHostRow;
      claim: PublicRouteProbeClaim;
    } => entry.claim != null,
  );
  const results = await Promise.all(
    claimed.map(({ row, claim }) =>
      executePublicRouteProbe({ row, claim, origin }),
    ),
  );
  const failures = results
    .map(({ alert }) => alert)
    .filter((alert): alert is NonNullable<typeof alert> => alert != null);
  await alertPublicRouteFailures({ origin, failures });
  await alertPublicRouteRecoveries(
    results.flatMap((result, index) =>
      result.recovered ? [claimed[index].row] : [],
    ),
  );
  const repairs = await runPublicRouteAutoRepair(
    results
      .map(({ failure }) => failure)
      .filter((failure): failure is PublicRouteFailure => failure != null),
  );
  const passed = results.filter(({ passed }) => passed).length;
  return {
    attempted: results.length,
    passed,
    failed: results.length - passed,
    quarantined: results.filter(({ quarantined }) => quarantined).length,
    repairs,
  };
}

async function updateAutoRecoveryState({
  host_id,
  state,
  expected_claim_id,
}: {
  host_id: string;
  state: Record<string, any>;
  expected_claim_id?: string;
}): Promise<boolean> {
  const params: any[] = [host_id, JSON.stringify(state)];
  const claimCondition = expected_claim_id
    ? `AND metadata -> 'runtime_auto_recovery' ->> 'claim_id'=$3`
    : "";
  if (expected_claim_id) params.push(expected_claim_id);
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{runtime_auto_recovery}',
        $2::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1 AND deleted IS NULL ${claimCondition}
    `,
    params,
  );
  return !!rowCount;
}

async function claimAutoReboot(
  row: RuntimeHostRow,
  attempts: RebootAttempt[],
): Promise<string | undefined> {
  const claimId = randomUUID();
  const now = Date.now();
  const state = {
    status: "claiming",
    claim_id: claimId,
    claimed_at: new Date(now).toISOString(),
    claim_expires_at: new Date(now + 5 * 60_000).toISOString(),
    host_boot_id: row.metadata?.host_boot_id,
    host_session_id: row.metadata?.host_session_id,
    attempts,
  };
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{runtime_auto_recovery}',
        $3::jsonb,
        true
      ), updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND status='running'
        AND metadata -> 'runtime_health' ->> 'status'='degraded'
        AND metadata ->> 'host_boot_id'=$2
        AND (
          metadata -> 'runtime_auto_recovery' ->> 'status' IS DISTINCT FROM 'claiming'
          OR COALESCE(
            (metadata -> 'runtime_auto_recovery' ->> 'claim_expires_at')::timestamptz,
            to_timestamp(0)
          ) < NOW()
        )
    `,
    [row.id, row.metadata?.host_boot_id, JSON.stringify(state)],
  );
  return rowCount ? claimId : undefined;
}

async function scheduleAutoReboot(
  row: RuntimeHostRow,
  attempts: RebootAttempt[],
): Promise<boolean> {
  const claimId = await claimAutoReboot(row, attempts);
  if (!claimId) return false;
  const now = Date.now();
  try {
    const workId = await enqueueCloudVmWorkOnce({
      vm_id: row.id,
      action: "hard_restart",
      payload: {
        source: "runtime-health-auto-recovery",
        runtime_health: row.metadata?.runtime_health,
        claim_id: claimId,
      },
    });
    const nextAttempts = [
      ...attempts,
      {
        at: new Date(now).toISOString(),
        host_boot_id: `${row.metadata?.host_boot_id}`,
        host_session_id: row.metadata?.host_session_id,
        work_id: workId,
      },
    ];
    await updateAutoRecoveryState({
      host_id: row.id,
      expected_claim_id: claimId,
      state: {
        status: "scheduled",
        claim_id: claimId,
        scheduled_at: new Date(now).toISOString(),
        cooldown_until: new Date(now + AUTO_REBOOT_COOLDOWN_MS).toISOString(),
        host_boot_id: row.metadata?.host_boot_id,
        host_session_id: row.metadata?.host_session_id,
        work_id: workId,
        attempts: nextAttempts,
      },
    });
    await adminAlert({
      subject: `Automatically rebooting degraded project host: ${hostName(row)}`,
      body: [
        `CoCalc captured runtime diagnostics and scheduled a bounded hard reboot for ${hostName(row)}.`,
        `host_id=${row.id}`,
        `provider=${cloudProvider(row)}`,
        `attempt=${nextAttempts.length}/${AUTO_REBOOT_MAX_ATTEMPTS} within ${Math.round(AUTO_REBOOT_WINDOW_MS / 3_600_000)}h`,
        `work_id=${workId ?? "already queued"}`,
        `synthetic_failure_kind=${row.metadata?.runtime_health?.synthetic_probe?.failure_kind ?? "unknown"}`,
        `runtime_error=${row.metadata?.runtime_health?.error ?? "unknown"}`,
      ].join("\n"),
      dedupMinutes: 10,
    });
    logger.error("scheduled automatic hard reboot for degraded project host", {
      host_id: row.id,
      host_name: hostName(row),
      work_id: workId,
      attempt: nextAttempts.length,
    });
    return true;
  } catch (err) {
    await updateAutoRecoveryState({
      host_id: row.id,
      expected_claim_id: claimId,
      state: {
        status: "enqueue_failed",
        failed_at: new Date().toISOString(),
        host_boot_id: row.metadata?.host_boot_id,
        host_session_id: row.metadata?.host_session_id,
        attempts,
        error: errorText(err),
      },
    });
    throw err;
  }
}

async function automaticRebootFleetGateOpen(): Promise<boolean> {
  const { rows } = await pool().query<{ count: string | number }>(
    `
      SELECT COUNT(*) AS count
      FROM cloud_vm_work
      WHERE action='hard_restart'
        AND payload ->> 'source'='runtime-health-auto-recovery'
        AND created_at >=
          NOW() - ($1::double precision * INTERVAL '1 millisecond')
    `,
    [AUTO_REBOOT_FLEET_SPACING_MS],
  );
  return Number(rows[0]?.count ?? 0) === 0;
}

async function markRecoveryExhausted(
  row: RuntimeHostRow,
  attempts: RebootAttempt[],
): Promise<void> {
  if (`${row.metadata?.runtime_auto_recovery?.status ?? ""}` === "exhausted") {
    return;
  }
  await updateAutoRecoveryState({
    host_id: row.id,
    state: {
      status: "exhausted",
      exhausted_at: new Date().toISOString(),
      host_boot_id: row.metadata?.host_boot_id,
      host_session_id: row.metadata?.host_session_id,
      attempts,
    },
  });
  await adminAlert({
    subject: `Automatic project-host recovery exhausted: ${hostName(row)}`,
    body: [
      `${hostName(row)} remains degraded after ${attempts.length} automatic hard reboots.`,
      `host_id=${row.id}`,
      `runtime_error=${row.metadata?.runtime_health?.error ?? "unknown"}`,
      "The host remains quarantined and requires operator investigation.",
    ].join("\n"),
    dedupMinutes: 60,
  });
}

export async function runBoundedRuntimeAutoRecovery(): Promise<{
  scheduled: number;
  exhausted: number;
}> {
  if (!enabled(process.env.COCALC_HOST_RUNTIME_AUTO_REBOOT_ENABLED)) {
    return { scheduled: 0, exhausted: 0 };
  }
  const rows = await listRuntimeHosts();
  let fleetGateOpen = await automaticRebootFleetGateOpen();
  let scheduled = 0;
  let exhausted = 0;
  for (const row of rows) {
    const decision = autoRebootDecision(row);
    if (decision.action === "reboot" && fleetGateOpen) {
      if (await scheduleAutoReboot(row, decision.attempts)) {
        scheduled += 1;
        fleetGateOpen = false;
      }
    } else if (decision.action === "exhausted") {
      await markRecoveryExhausted(row, decision.attempts);
      exhausted += 1;
    }
  }
  return { scheduled, exhausted };
}

let maintenanceInflight: Promise<void> | undefined;

export async function runProjectHostRuntimeMaintenance(): Promise<void> {
  if (maintenanceInflight) return await maintenanceInflight;
  maintenanceInflight = (async () => {
    const recovery = await runBoundedRuntimeAutoRecovery();
    const [probes, publicRoutes] = await Promise.all([
      runSyntheticProjectHostProbes(),
      runProjectHostPublicRouteProbes(),
    ]);
    logger.debug("project-host runtime maintenance complete", {
      recovery,
      probes,
      public_routes: publicRoutes,
    });
  })();
  try {
    await maintenanceInflight;
  } finally {
    maintenanceInflight = undefined;
  }
}

export const _test = {
  autoRebootDecision,
  claimPublicRouteAutoRepair,
  deploymentLabel,
  recentRebootAttempts,
  recoveredAutoRebootState,
  publicRouteProbeDue,
  publicRouteProbeFailureAlertDue,
  publicRouteProbeOutcome,
  publicRouteAutoRepairDecision,
  syntheticProbeOutcome,
  syntheticProbeFailureAlertDue,
  syntheticProbeDue,
};
