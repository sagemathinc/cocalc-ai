/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";

const logger = getLogger("server:hosts:intrusion-monitor");

const TABLE = "project_host_intrusion_snapshots";
const NORMALIZATION_VERSION = 1;
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CONCURRENCY = 2;
const HOST_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const HOST_RPC_TIMEOUT_MS = 130_000;
const COVERAGE_FAILURE_ALERT_THRESHOLD = 3;
const MAX_ALERT_HOSTS = 20;
const MAX_ALERT_ENTRIES_PER_CATEGORY = 10;
const MAX_ALERT_BODY_CHARS = 60_000;
const LOCK_KEY = "project_host_intrusion_monitor";

const MONITORED_CATEGORIES = [
  "accounts.uid_zero",
  "accounts.interactive",
  "host_processes.summary",
  "host_processes.findings",
  "persistence.files",
  "privileged_files.writable",
  "privileged_files.suid_sgid",
  "privileged_files.capabilities",
  "services.enabled",
  "services.failed",
  "network.listeners",
  "authentication_7d.accepted",
  "kernel_signals_7d",
  "package_integrity.differences",
] as const;

type MonitoredCategory = (typeof MONITORED_CATEGORIES)[number];

const ADDITION_ONLY_CATEGORIES = new Set<MonitoredCategory>([
  "authentication_7d.accepted",
  "kernel_signals_7d",
]);

export interface NormalizedHostIntrusionSnapshot {
  version: 1;
  identity: {
    hostname: string;
    kernel: string;
    boot_id: string;
  };
  coverage: HostIntrusionSnapshotResponse["coverage"];
  signals: Record<MonitoredCategory | "network.established", string[]>;
  counters: {
    scanned_process_count: number;
    host_process_count: number;
    authentication_failed_7d: number;
    authentication_invalid_user_7d: number;
    kernel_signals_7d: Record<string, number>;
  };
  issues: string[];
  truncated: string[];
}

export interface HostIntrusionSnapshotDelta {
  added: Partial<Record<MonitoredCategory, string[]>>;
  removed: Partial<Record<MonitoredCategory, string[]>>;
}

type CandidateHost = {
  id: string;
  name?: string | null;
  public_url?: string | null;
};

type PreviousSnapshotRow = {
  normalized: NormalizedHostIntrusionSnapshot;
};

type CoverageRow = {
  coverage: HostIntrusionSnapshotResponse["coverage"];
};

type FleetSnapshotRow = {
  normalized: NormalizedHostIntrusionSnapshot;
};

type PersistSnapshotOptions = {
  hostId: string;
  bayId: string;
  source: HostIntrusionSnapshotResponse;
  normalized: NormalizedHostIntrusionSnapshot;
  delta?: HostIntrusionSnapshotDelta;
};

type HostTransition = {
  host: CandidateHost;
  delta: HostIntrusionSnapshotDelta;
  baseline: "host" | "fleet";
};

type CoverageFailure = {
  host: CandidateHost;
  coverage: HostIntrusionSnapshotResponse["coverage"] | "error";
  detail?: string;
};

export interface HostIntrusionMonitorResult {
  checked: number;
  changed: number;
  baselined: number;
  incomplete: number;
  failed: number;
}

let schemaReady: Promise<void> | undefined;
let started = false;

function envNumberAtLeast(
  name: string,
  fallback: number,
  minimum: number,
): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function encode(fields: unknown[]): string {
  return JSON.stringify(fields);
}

function normalizeStringRecord(
  record: Record<string, unknown>,
  keys: string[],
): string {
  return encode(keys.map((key) => record[key] ?? null));
}

export function normalizeHostIntrusionSnapshot(
  snapshot: HostIntrusionSnapshotResponse,
): NormalizedHostIntrusionSnapshot {
  const signals = {
    "accounts.uid_zero": sortedUnique(
      snapshot.accounts.uid_zero.map((entry) =>
        normalizeStringRecord(entry, ["name", "uid", "gid", "home", "shell"]),
      ),
    ),
    "accounts.interactive": sortedUnique(
      snapshot.accounts.interactive.map((entry) =>
        normalizeStringRecord(entry, ["name", "uid", "gid", "home", "shell"]),
      ),
    ),
    "host_processes.summary": sortedUnique(
      snapshot.host_processes.summary.map((entry) =>
        normalizeStringRecord(entry, [
          "uid",
          "comm",
          "exe",
          "capability_mask",
          "executable_uid",
          "executable_mode",
        ]),
      ),
    ),
    "host_processes.findings": sortedUnique(
      snapshot.host_processes.findings.map((entry) =>
        encode([
          entry.uid,
          entry.comm,
          entry.exe,
          entry.capability_mask,
          entry.executable_uid ?? null,
          entry.executable_mode ?? null,
          [...entry.flags].sort(),
        ]),
      ),
    ),
    "persistence.files": sortedUnique(
      snapshot.persistence.files.map((entry) =>
        encode([
          entry.path,
          entry.uid,
          entry.gid,
          entry.mode,
          entry.type,
          entry.sha256 ?? null,
        ]),
      ),
    ),
    "privileged_files.writable": sortedUnique(
      snapshot.privileged_files.writable,
    ),
    "privileged_files.suid_sgid": sortedUnique(
      snapshot.privileged_files.suid_sgid,
    ),
    "privileged_files.capabilities": sortedUnique(
      snapshot.privileged_files.capabilities,
    ),
    "services.enabled": sortedUnique(snapshot.services.enabled),
    "services.failed": sortedUnique(snapshot.services.failed),
    "network.listeners": sortedUnique(
      snapshot.network.listeners.map((entry) =>
        normalizeStringRecord(entry, ["protocol", "process", "local"]),
      ),
    ),
    "network.established": sortedUnique(
      snapshot.network.established.map((entry) =>
        normalizeStringRecord(entry, ["process", "local_port", "peer"]),
      ),
    ),
    "authentication_7d.accepted": sortedUnique(
      snapshot.authentication_7d.accepted.map((entry) =>
        normalizeStringRecord(entry, ["method", "user", "source"]),
      ),
    ),
    kernel_signals_7d: sortedUnique(
      Object.entries(snapshot.kernel_signals_7d)
        .filter(([, count]) => Number(count) > 0)
        .map(([name]) => name),
    ),
    "package_integrity.differences": sortedUnique(
      snapshot.package_integrity.differences,
    ),
  } satisfies NormalizedHostIntrusionSnapshot["signals"];

  return {
    version: NORMALIZATION_VERSION,
    identity: {
      hostname: snapshot.hostname,
      kernel: snapshot.kernel,
      boot_id: snapshot.boot_id,
    },
    coverage: snapshot.coverage,
    signals,
    counters: {
      scanned_process_count: snapshot.host_processes.scanned_process_count,
      host_process_count: snapshot.host_processes.process_count,
      authentication_failed_7d: snapshot.authentication_7d.failed,
      authentication_invalid_user_7d: snapshot.authentication_7d.invalid_user,
      kernel_signals_7d: Object.fromEntries(
        Object.entries(snapshot.kernel_signals_7d).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    },
    issues: sortedUnique(
      snapshot.issues.map(({ section, code }) => `${section}:${code}`),
    ),
    truncated: sortedUnique(
      Object.entries(snapshot.truncated)
        .filter(([, value]) => value)
        .map(([key]) => key),
    ),
  };
}

export function diffHostIntrusionSnapshots(
  previous: NormalizedHostIntrusionSnapshot,
  current: NormalizedHostIntrusionSnapshot,
): HostIntrusionSnapshotDelta {
  const added: HostIntrusionSnapshotDelta["added"] = {};
  const removed: HostIntrusionSnapshotDelta["removed"] = {};
  for (const category of MONITORED_CATEGORIES) {
    const before = new Set(previous.signals[category] ?? []);
    const after = new Set(current.signals[category] ?? []);
    const newValues = [...after].filter((value) => !before.has(value)).sort();
    const oldValues = [...before].filter((value) => !after.has(value)).sort();
    if (newValues.length) added[category] = newValues;
    if (oldValues.length && !ADDITION_ONLY_CATEGORIES.has(category)) {
      removed[category] = oldValues;
    }
  }
  return { added, removed };
}

export function hasHostIntrusionSnapshotChanges(
  delta: HostIntrusionSnapshotDelta,
): boolean {
  return (
    Object.keys(delta.added).length > 0 || Object.keys(delta.removed).length > 0
  );
}

export function diffHostIntrusionSnapshotAgainstFleet(
  fleet: NormalizedHostIntrusionSnapshot[],
  current: NormalizedHostIntrusionSnapshot,
): HostIntrusionSnapshotDelta {
  const added: HostIntrusionSnapshotDelta["added"] = {};
  for (const category of MONITORED_CATEGORIES) {
    const observed = new Set(
      fleet.flatMap((snapshot) => snapshot.signals[category] ?? []),
    );
    const newValues = current.signals[category].filter(
      (value) => !observed.has(value),
    );
    if (newValues.length) added[category] = newValues;
  }
  return { added, removed: {} };
}

function monitoredFingerprint(
  snapshot: NormalizedHostIntrusionSnapshot,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        MONITORED_CATEGORIES.map((category) => [
          category,
          snapshot.signals[category],
        ]),
      ),
    )
    .digest("hex");
}

export async function ensureHostIntrusionMonitorSchema(): Promise<void> {
  const attempt = (schemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id UUID PRIMARY KEY,
        host_id UUID NOT NULL,
        bay_id TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        duration_ms INTEGER NOT NULL,
        coverage TEXT NOT NULL,
        normalization_version INTEGER NOT NULL,
        fingerprint TEXT,
        normalized JSONB NOT NULL,
        delta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (coverage IN ('complete', 'partial', 'unavailable'))
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${TABLE}_host_created_idx
      ON ${TABLE} (host_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${TABLE}_created_idx
      ON ${TABLE} (created_at)
    `);
  })());
  try {
    await attempt;
  } catch (err) {
    if (schemaReady === attempt) schemaReady = undefined;
    throw err;
  }
}

async function listCandidateHosts(bayId: string): Promise<CandidateHost[]> {
  const { rows } = await getPool().query<CandidateHost>(
    `
      SELECT id, name, public_url
      FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND last_seen >= NOW() - ($1::double precision * INTERVAL '1 millisecond')
        AND COALESCE(NULLIF(bay_id, ''), $2) = $2
      ORDER BY id
    `,
    [HOST_ONLINE_WINDOW_MS, bayId],
  );
  return rows;
}

async function loadPreviousCompleteSnapshot(
  hostId: string,
): Promise<NormalizedHostIntrusionSnapshot | undefined> {
  const { rows } = await getPool().query<PreviousSnapshotRow>(
    `
      SELECT normalized
      FROM ${TABLE}
      WHERE host_id = $1
        AND coverage = 'complete'
        AND normalization_version = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [hostId, NORMALIZATION_VERSION],
  );
  return rows[0]?.normalized;
}

async function loadRecentCoverage(hostId: string): Promise<CoverageRow[]> {
  const { rows } = await getPool().query<CoverageRow>(
    `
      SELECT coverage
      FROM ${TABLE}
      WHERE host_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [hostId, COVERAGE_FAILURE_ALERT_THRESHOLD - 1],
  );
  return rows;
}

async function loadFleetCompleteSnapshots({
  bayId,
  excludeHostId,
}: {
  bayId: string;
  excludeHostId: string;
}): Promise<NormalizedHostIntrusionSnapshot[]> {
  const { rows } = await getPool().query<FleetSnapshotRow>(
    `
      SELECT DISTINCT ON (snapshots.host_id) snapshots.normalized
      FROM ${TABLE} AS snapshots
      INNER JOIN project_hosts AS hosts ON hosts.id = snapshots.host_id
      WHERE snapshots.bay_id = $1
        AND snapshots.host_id <> $2
        AND snapshots.coverage = 'complete'
        AND snapshots.normalization_version = $3
        AND hosts.deleted IS NULL
        AND hosts.status = 'running'
        AND hosts.last_seen >= NOW() - ($4::double precision * INTERVAL '1 millisecond')
        AND COALESCE(NULLIF(hosts.bay_id, ''), $1) = $1
      ORDER BY snapshots.host_id, snapshots.created_at DESC
    `,
    [bayId, excludeHostId, NORMALIZATION_VERSION, HOST_ONLINE_WINDOW_MS],
  );
  return rows.map(({ normalized }) => normalized);
}

export async function activeFleetHasCompleteBaseline(
  bayId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM ${TABLE} AS snapshots
         INNER JOIN project_hosts AS hosts ON hosts.id = snapshots.host_id
        WHERE snapshots.bay_id = $1
          AND snapshots.coverage = 'complete'
          AND snapshots.normalization_version = $2
          AND hosts.deleted IS NULL
          AND hosts.status = 'running'
          AND hosts.last_seen >= NOW() - ($3::double precision * INTERVAL '1 millisecond')
          AND COALESCE(NULLIF(hosts.bay_id, ''), $1) = $1
     ) AS present`,
    [bayId, NORMALIZATION_VERSION, HOST_ONLINE_WINDOW_MS],
  );
  return rows[0]?.present === true;
}

async function persistSnapshot({
  hostId,
  bayId,
  source,
  normalized,
  delta,
}: PersistSnapshotOptions): Promise<void> {
  await getPool().query(
    `
      INSERT INTO ${TABLE} (
        id, host_id, bay_id, captured_at, duration_ms, coverage,
        normalization_version, fingerprint, normalized, delta
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
    `,
    [
      randomUUID(),
      hostId,
      bayId,
      source.captured_at,
      Math.max(0, Math.floor(source.duration_ms)),
      source.coverage,
      NORMALIZATION_VERSION,
      source.coverage === "complete" ? monitoredFingerprint(normalized) : null,
      JSON.stringify(normalized),
      delta == null ? null : JSON.stringify(delta),
    ],
  );
}

function hostLabel(host: CandidateHost): string {
  return `${host.name ?? ""}`.trim() || host.id;
}

function displaySignal(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed).replaceAll("`", "'");
  } catch {
    return value.replaceAll("`", "'");
  }
}

function boundedAlertBody(lines: Array<string | undefined>): string {
  const body = lines.filter((line) => line != null).join("\n");
  if (body.length <= MAX_ALERT_BODY_CHARS) return body;
  return `${body.slice(0, MAX_ALERT_BODY_CHARS)}\n\n[alert body truncated]`;
}

function formatTransitionAlert(transitions: HostTransition[]): string {
  const lines = [
    `${transitions.length} project host${transitions.length === 1 ? " has" : "s have"} security-state changes relative to an available host or fleet baseline.`,
    "",
    "This monitor is report-only. Review each change and run a fresh admin host intrusion-snapshot when deeper evidence is needed.",
  ];
  for (const { host, delta, baseline } of transitions.slice(
    0,
    MAX_ALERT_HOSTS,
  )) {
    lines.push(
      "",
      `Host ${hostLabel(host)} host_id=${host.id} baseline=${baseline}`,
    );
    if (host.public_url) lines.push(`url=${host.public_url}`);
    for (const direction of ["added", "removed"] as const) {
      for (const [category, entries] of Object.entries(delta[direction])) {
        lines.push(`${direction} ${category}:`);
        for (const entry of entries.slice(0, MAX_ALERT_ENTRIES_PER_CATEGORY)) {
          lines.push(`- \`${displaySignal(entry)}\``);
        }
        if (entries.length > MAX_ALERT_ENTRIES_PER_CATEGORY) {
          lines.push(
            `- ... ${entries.length - MAX_ALERT_ENTRIES_PER_CATEGORY} more`,
          );
        }
      }
    }
  }
  if (transitions.length > MAX_ALERT_HOSTS) {
    lines.push("", `... ${transitions.length - MAX_ALERT_HOSTS} more hosts`);
  }
  return boundedAlertBody(lines);
}

function formatCoverageAlert(failures: CoverageFailure[]): string {
  return boundedAlertBody([
    `${failures.length} project host intrusion collector${failures.length === 1 ? " has" : "s have"} failed to produce complete coverage for ${COVERAGE_FAILURE_ALERT_THRESHOLD} consecutive checks.`,
    "",
    "Incomplete snapshots do not replace the last complete security baseline.",
    "",
    ...failures
      .slice(0, MAX_ALERT_HOSTS)
      .map(({ host, coverage, detail }) =>
        [
          `- ${hostLabel(host)}`,
          `host_id=${host.id}`,
          `coverage=${coverage}`,
          detail ? `detail=${detail}` : undefined,
          host.public_url ? `url=${host.public_url}` : undefined,
        ]
          .filter((part) => part != null)
          .join(" "),
      ),
    failures.length > MAX_ALERT_HOSTS
      ? `- ... ${failures.length - MAX_ALERT_HOSTS} more`
      : undefined,
  ]);
}

function formatInitialBaselineAlert(hosts: CandidateHost[]): string {
  return boundedAlertBody([
    `The report-only project host intrusion monitor established initial baselines for ${hosts.length} host${hosts.length === 1 ? "" : "s"}.`,
    "",
    "A baseline is not a clean-state certification. Review these hosts with the admin host intrusion-snapshot command. Future complete samples will be diffed against these baselines, while incomplete samples can never replace them.",
    "",
    ...hosts
      .slice(0, MAX_ALERT_HOSTS)
      .map((host) =>
        [
          `- ${hostLabel(host)}`,
          `host_id=${host.id}`,
          host.public_url ? `url=${host.public_url}` : undefined,
        ]
          .filter((part) => part != null)
          .join(" "),
      ),
    hosts.length > MAX_ALERT_HOSTS
      ? `- ... ${hosts.length - MAX_ALERT_HOSTS} more`
      : undefined,
  ]);
}

export function reachedCoverageFailureThreshold(rows: CoverageRow[]): boolean {
  const preceding = rows.slice(0, COVERAGE_FAILURE_ALERT_THRESHOLD - 1);
  if (preceding.length !== COVERAGE_FAILURE_ALERT_THRESHOLD - 1) return false;
  return preceding.every(({ coverage }) => coverage !== "complete");
}

function unavailableSource(host: CandidateHost): HostIntrusionSnapshotResponse {
  return {
    version: 1,
    captured_at: new Date().toISOString(),
    duration_ms: 0,
    hostname: hostLabel(host),
    kernel: "",
    boot_id: "",
    coverage: "unavailable",
    accounts: { uid_zero: [], interactive: [] },
    host_processes: {
      scanned_process_count: 0,
      process_count: 0,
      summary: [],
      findings: [],
    },
    persistence: { files: [], truncated: false },
    privileged_files: { writable: [], suid_sgid: [], capabilities: [] },
    services: { enabled: [], failed: [] },
    network: { listeners: [], established: [] },
    authentication_7d: { accepted: [], failed: 0, invalid_user: 0 },
    kernel_signals_7d: {},
    package_integrity: { manager: "unavailable", differences: [] },
    issues: [{ section: "monitor", code: "RPC_FAILED" }],
    truncated: {},
  };
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index++];
        await fn(value);
      }
    },
  );
  await Promise.all(workers);
}

async function pruneOldSnapshots(retentionDays: number): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM ${TABLE}
      WHERE created_at < NOW() - ($1::double precision * INTERVAL '1 day')`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

export async function runHostIntrusionMonitorPass(): Promise<HostIntrusionMonitorResult> {
  await ensureHostIntrusionMonitorSchema();
  const bayId = getConfiguredBayId();
  const hosts = await listCandidateHosts(bayId);
  // The first complete pass establishes the fleet as a unit. Hosts added later
  // are also compared with active peers, so a first sample cannot silently
  // introduce novel state.
  const hadActiveFleetBaseline = await activeFleetHasCompleteBaseline(bayId);
  const transitions: HostTransition[] = [];
  const coverageFailures: CoverageFailure[] = [];
  const initialBaselines: CandidateHost[] = [];
  const deferredCompleteSnapshots: PersistSnapshotOptions[] = [];
  const result: HostIntrusionMonitorResult = {
    checked: 0,
    changed: 0,
    baselined: 0,
    incomplete: 0,
    failed: 0,
  };
  const concurrency = Math.floor(
    envNumberAtLeast(
      "COCALC_HOST_INTRUSION_MONITOR_CONCURRENCY",
      DEFAULT_CONCURRENCY,
      1,
    ),
  );

  await mapWithConcurrency(hosts, concurrency, async (host) => {
    result.checked += 1;
    try {
      const previousCoverage = await loadRecentCoverage(host.id);
      const source = await (
        await getRoutedHostControlClient({
          host_id: host.id,
          timeout: HOST_RPC_TIMEOUT_MS,
          fresh: true,
        })
      ).getIntrusionSnapshot();
      const normalized = normalizeHostIntrusionSnapshot(source);
      if (source.coverage !== "complete") {
        result.incomplete += 1;
        await persistSnapshot({
          hostId: host.id,
          bayId,
          source,
          normalized,
        });
        if (reachedCoverageFailureThreshold(previousCoverage)) {
          coverageFailures.push({ host, coverage: source.coverage });
        }
        return;
      }

      const previous = await loadPreviousCompleteSnapshot(host.id);
      let delta: HostIntrusionSnapshotDelta | undefined;
      let baseline: HostTransition["baseline"] = "host";
      let comparedWithFleet = false;
      if (previous) {
        delta = diffHostIntrusionSnapshots(previous, normalized);
      } else if (hadActiveFleetBaseline) {
        const fleet = await loadFleetCompleteSnapshots({
          bayId,
          excludeHostId: host.id,
        });
        if (fleet.length) {
          delta = diffHostIntrusionSnapshotAgainstFleet(fleet, normalized);
          baseline = "fleet";
          comparedWithFleet = true;
        }
      }
      const completeSnapshot = {
        hostId: host.id,
        bayId,
        source,
        normalized,
        delta,
      };
      const changedDelta =
        delta != null && hasHostIntrusionSnapshotChanges(delta)
          ? delta
          : undefined;
      const needsInitialReview = !previous && !comparedWithFleet;
      // Do not promote a security baseline until its alert is accepted. If
      // delivery fails, the next pass compares against the older baseline and
      // retries rather than silently absorbing the transition.
      if (changedDelta || needsInitialReview) {
        deferredCompleteSnapshots.push(completeSnapshot);
      } else {
        await persistSnapshot(completeSnapshot);
      }
      if (!previous) {
        result.baselined += 1;
        if (needsInitialReview) initialBaselines.push(host);
      }
      if (changedDelta) {
        result.changed += 1;
        transitions.push({ host, delta: changedDelta, baseline });
      }
    } catch (err) {
      result.failed += 1;
      logger.warn("failed collecting project-host intrusion snapshot", {
        host_id: host.id,
        err: `${err}`,
      });
      const previousCoverage = await loadRecentCoverage(host.id).catch(
        () => [],
      );
      const source = unavailableSource(host);
      await persistSnapshot({
        hostId: host.id,
        bayId,
        source,
        normalized: normalizeHostIntrusionSnapshot(source),
      }).catch((persistErr) => {
        logger.warn("failed persisting unavailable intrusion snapshot", {
          host_id: host.id,
          err: `${persistErr}`,
        });
      });
      if (reachedCoverageFailureThreshold(previousCoverage)) {
        coverageFailures.push({
          host,
          coverage: "error",
          detail: `${err}`.slice(0, 300),
        });
      }
    }
  });

  if (transitions.length) {
    await adminAlert({
      subject: "Project host intrusion monitor detected security-state changes",
      body: formatTransitionAlert(transitions),
      dedupMinutes: 5,
      errorOnFail: true,
    });
  }
  if (coverageFailures.length) {
    await adminAlert({
      subject: "Project host intrusion monitoring has incomplete coverage",
      body: formatCoverageAlert(coverageFailures),
      dedupMinutes: 60,
      errorOnFail: true,
    });
  }
  if (initialBaselines.length) {
    await adminAlert({
      subject:
        "Project host intrusion monitoring established initial baselines",
      body: formatInitialBaselineAlert(initialBaselines),
      dedupMinutes: 60,
      errorOnFail: true,
    });
  }

  await mapWithConcurrency(
    deferredCompleteSnapshots,
    concurrency,
    persistSnapshot,
  );

  const retentionDays = envNumberAtLeast(
    "COCALC_HOST_INTRUSION_MONITOR_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
    7,
  );
  const pruned = await pruneOldSnapshots(retentionDays);
  if (pruned) logger.info("pruned old host intrusion snapshots", { pruned });
  return result;
}

async function runLockedPass(): Promise<void> {
  const result = await withSessionAdvisoryLock({
    lockKey: `${LOCK_KEY}:${getConfiguredBayId()}`,
    fn: runHostIntrusionMonitorPass,
  });
  if (result) {
    logger.info("project-host intrusion monitoring pass complete", result);
  }
}

export function startHostIntrusionMonitor(): void {
  if (started || process.env.COCALC_HOST_INTRUSION_MONITOR === "0") return;
  started = true;
  const intervalMs = envNumberAtLeast(
    "COCALC_HOST_INTRUSION_MONITOR_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
  );
  logger.info("starting project-host intrusion monitor", {
    interval_ms: intervalMs,
    normalization_version: NORMALIZATION_VERSION,
  });
  void runLockedPass().catch((err) => {
    logger.error("project-host intrusion monitoring failed", err);
  });
  const timer = setInterval(() => {
    void runLockedPass().catch((err) => {
      logger.error("project-host intrusion monitoring failed", err);
    });
  }, intervalMs);
  timer.unref?.();
}
