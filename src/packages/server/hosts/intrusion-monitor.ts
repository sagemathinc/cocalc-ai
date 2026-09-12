/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";

import getLogger from "@cocalc/backend/logger";
import type { HostIntrusionSnapshotResponse } from "@cocalc/conat/project-host/api";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";

const logger = getLogger("server:hosts:intrusion-monitor");

const TABLE = "project_host_intrusion_snapshots";
const NORMALIZATION_VERSION = 2;
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SNAP_REFRESH_CONFIRMATION_DELAY_MS = 60_000;
const MIN_SNAP_REFRESH_CONFIRMATION_DELAY_MS = 10_000;
const HOST_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const HOST_RPC_TIMEOUT_MS = 130_000;
const COVERAGE_FAILURE_ALERT_THRESHOLD = 3;
const MAX_ALERT_HOSTS = 20;
const MAX_ALERT_ENTRIES_PER_CATEGORY = 10;
const MAX_ALERT_BODY_CHARS = 60_000;
const LOCK_KEY = "project_host_intrusion_monitor";

type TransitionAlertMode = "actionable" | "all" | "off";

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

const DYNAMIC_LISTENER_PROCESSES = new Set([
  "cloudflared",
  // Linux comm truncates the project-host worker process titles.
  "project-host:ac",
  "project-host:ap",
  "rustic",
  "sshpiperd",
]);
const DYNAMIC_LISTENER_MIN_PORT = 10_000;
const EPHEMERAL_LISTENER_MIN_PORT = 32_768;
const NON_INTRUSION_KERNEL_SIGNALS = new Set(["oom", "tainted"]);
const BACKUP_BROWSER_CGROUP = "/cocalc-backup-browsers/browser-*";
const EXPECTED_IAP_SSH_USERS = new Set(["ubuntu", "user"]);
const GOOGLE_IAP_SOURCES = new BlockList();
GOOGLE_IAP_SOURCES.addSubnet("35.235.240.0", 20, "ipv4");
GOOGLE_IAP_SOURCES.addSubnet("2600:2d00:1:7::", 64, "ipv6");

// Broad inventory and rolling operational history remain queryable evidence;
// only categories with a concrete operator response generate notifications.
const ACTIONABLE_ADDITIONS = new Set<MonitoredCategory>([
  "accounts.uid_zero",
  "accounts.interactive",
  "host_processes.findings",
  "persistence.files",
  "privileged_files.writable",
  "privileged_files.suid_sgid",
  "privileged_files.capabilities",
  "services.enabled",
  "network.listeners",
  "authentication_7d.accepted",
  "package_integrity.differences",
]);

const ACTIONABLE_REMOVALS = new Set<MonitoredCategory>([
  "accounts.uid_zero",
  "accounts.interactive",
  "persistence.files",
  "services.enabled",
]);

export interface NormalizedHostIntrusionSnapshot {
  version: 2;
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
  assessment?: SnapshotAssessment;
  baselineEligible?: boolean;
};

type SnapshotAssessment =
  | { state: "observed" }
  | {
      state: "pending_snap_refresh_confirmation";
      fingerprint: string;
      units: string[];
    }
  | {
      state: "resolved_snap_refresh_confirmation";
      pending_snapshot_id: string;
      fingerprint: string;
      resolution: "attested" | "reverted";
    }
  | {
      state: "notified_snap_refresh_confirmation";
      pending_snapshot_id: string;
      fingerprint: string;
      units: string[];
    };

type PendingSnapRefreshRow = {
  id: string;
  assessment: Extract<
    SnapshotAssessment,
    { state: "pending_snap_refresh_confirmation" }
  >;
};

export type SnapRefreshConfirmationCandidate = {
  fingerprint: string;
  units: string[];
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
  pending: number;
  baselined: number;
  incomplete: number;
  failed: number;
}

let schemaReady: Promise<void> | undefined;
let started = false;
let pendingConfirmationTimer: ReturnType<typeof setTimeout> | undefined;

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

function decodeSignal(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isExpectedTransientProcess(value: string): boolean {
  const fields = decodeSignal(value);
  if (!fields) return false;
  const [uid, comm, exe, capabilities, executableUid, executableMode, cgroup] =
    fields;
  const zeroCapabilities =
    typeof capabilities === "string" && /^0+$/.test(capabilities);
  const rootOwnedExecutable = executableUid === 0 && executableMode === "0755";
  if (
    uid === 0 &&
    comm === "btrfs" &&
    exe === "/usr/bin/btrfs" &&
    capabilities === "000001ffffffffff" &&
    rootOwnedExecutable
  ) {
    return true;
  }
  if (
    typeof uid === "number" &&
    uid !== 0 &&
    ((comm === "bash" && exe === "/usr/bin/bash") ||
      (comm === "sleep" && exe === "/usr/bin/sleep")) &&
    zeroCapabilities &&
    rootOwnedExecutable &&
    cgroup === BACKUP_BROWSER_CGROUP
  ) {
    return true;
  }
  if (
    typeof uid === "number" &&
    uid !== 0 &&
    comm === "sshd" &&
    exe === "/usr/sbin/sshd" &&
    zeroCapabilities &&
    rootOwnedExecutable
  ) {
    return true;
  }
  if (
    typeof uid === "number" &&
    uid !== 0 &&
    comm === "rustic" &&
    typeof exe === "string" &&
    /^\/opt\/cocalc\/tools\/[^/]+\/rustic$/.test(exe) &&
    zeroCapabilities &&
    executableUid === uid &&
    executableMode === "0755"
  ) {
    return true;
  }
  return false;
}

function canonicalizeListener(value: string): string {
  const fields = decodeSignal(value);
  if (!fields || fields.length !== 3) return value;
  const [protocol, process, local] = fields;
  if (
    typeof process !== "string" ||
    !DYNAMIC_LISTENER_PROCESSES.has(process) ||
    typeof local !== "string"
  ) {
    return value;
  }
  const match = /^(.*):(\d+)$/.exec(local);
  if (!match || Number(match[2]) < DYNAMIC_LISTENER_MIN_PORT) return value;
  return encode([protocol, process, `${match[1]}:<dynamic>`]);
}

function isGoogleIapSource(source: unknown): boolean {
  if (typeof source !== "string") return false;
  const family = isIP(source);
  if (family === 0) return false;
  return GOOGLE_IAP_SOURCES.check(source, family === 4 ? "ipv4" : "ipv6");
}

function isActionableAuthentication(
  value: string,
  trustedAdminSshSources: Set<string>,
): boolean {
  const fields = decodeSignal(value);
  return (
    fields == null ||
    fields[0] !== "publickey" ||
    typeof fields[1] !== "string" ||
    !EXPECTED_IAP_SSH_USERS.has(fields[1]) ||
    typeof fields[2] !== "string" ||
    (!isGoogleIapSource(fields[2]) && !trustedAdminSshSources.has(fields[2]))
  );
}

export function configuredTrustedAdminSshSources(
  bayId: string,
  configured = process.env
    .COCALC_HOST_INTRUSION_TRUSTED_ADMIN_SSH_SOURCES_BY_BAY,
): string[] {
  // This is deliberately keyed by bay rather than a global allowlist. An
  // operator address valid for one deployment must remain actionable in all
  // others unless each bay explicitly opts in.
  if (!configured) return [];
  try {
    const byBay: unknown = JSON.parse(configured);
    if (byBay == null || typeof byBay !== "object" || Array.isArray(byBay)) {
      throw Error("configuration must be a JSON object");
    }
    const values = (byBay as Record<string, unknown>)[bayId];
    if (values == null) return [];
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string" || isIP(value) === 0)
    ) {
      throw Error(`configuration for bay ${bayId} must contain only IPs`);
    }
    return [...new Set(values as string[])];
  } catch (err) {
    logger.warn("invalid bay-scoped trusted admin SSH source configuration", {
      bayId,
      err,
    });
    return [];
  }
}

function isActionableListener(value: string): boolean {
  const fields = decodeSignal(value);
  if (!fields || fields.length !== 3) return true;
  const [protocol, process, local] = fields;
  if (typeof protocol !== "string" || typeof local !== "string") return true;
  const match = /^(.*):(\d+|<dynamic>)$/.exec(local);
  if (!match) return true;
  if (match[2] === "<dynamic>") return false;
  const host = match[1].replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) {
    if (
      process === "unattributed" &&
      match[2] !== "<dynamic>" &&
      Number(match[2]) >= EPHEMERAL_LISTENER_MIN_PORT
    ) {
      return false;
    }
    return (
      typeof process !== "string" || !DYNAMIC_LISTENER_PROCESSES.has(process)
    );
  }
  const port = Number(match[2]);
  if (
    protocol === "udp" &&
    process === "unattributed" &&
    port >= EPHEMERAL_LISTENER_MIN_PORT
  ) {
    return false;
  }
  return true;
}

type SnapRevisionSignal = {
  identity: string;
  key: string;
  revision: string;
  unit: string;
};

function snapRevisionSignal(
  category: MonitoredCategory,
  value: string,
): SnapRevisionSignal | undefined {
  if (category === "services.enabled") {
    const match = /snap-([^/\s]+)-(\d+)\.mount/.exec(value);
    if (!match) return;
    return {
      identity: match[1],
      key: value.replace(match[0], `snap-${match[1]}-<revision>.mount`),
      revision: match[2],
      unit: match[0],
    };
  }
  if (category === "persistence.files") {
    const fields = decodeSignal(value);
    if (!fields || typeof fields[0] !== "string") return;
    if (!fields[0].startsWith("/etc/systemd/system/")) return;
    const match = /snap-([^/\s]+)-(\d+)\.mount/.exec(fields[0]);
    if (!match) return;
    fields[0] = fields[0].replace(
      match[0],
      `snap-${match[1]}-<revision>.mount`,
    );
    // Revision-specific mount unit content changes along with its filename.
    fields[5] = null;
    return {
      identity: match[1],
      key: encode(fields),
      revision: match[2],
      unit: match[0],
    };
  }
  return;
}

function baselineSnapMountIdentities(
  snapshots: NormalizedHostIntrusionSnapshot[],
): Set<string> {
  const identities = new Set<string>();
  for (const snapshot of snapshots) {
    for (const value of snapshot.signals["services.enabled"] ?? []) {
      const signal = snapRevisionSignal("services.enabled", value);
      if (signal && value === `${signal.unit} enabled enabled`) {
        identities.add(signal.identity);
      }
    }
  }
  return identities;
}

function isStructurallyValidSnapMountAddition({
  category,
  value,
  delta,
}: {
  category: "persistence.files" | "services.enabled";
  value: string;
  delta: HostIntrusionSnapshotDelta;
}): boolean {
  const signal = snapRevisionSignal(category, value);
  if (!signal) return false;
  // A same-revision removal indicates content or metadata changed, rather than
  // snapd adding a newly active mount. Keep that transition actionable.
  if (
    (delta.removed[category] ?? []).some((removed) => {
      const previous = snapRevisionSignal(category, removed);
      return previous?.unit === signal.unit;
    })
  ) {
    return false;
  }
  if (category === "services.enabled") {
    return value === `${signal.unit} enabled enabled`;
  }
  const fields = decodeSignal(value);
  if (!fields || fields.length !== 6) return false;
  const [path, uid, gid, mode, type, sha256] = fields;
  if (uid !== 0 || gid !== 0 || typeof path !== "string") return false;
  if (path === `/etc/systemd/system/${signal.unit}`) {
    return (
      mode === "0644" &&
      type === "file" &&
      typeof sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(sha256)
    );
  }
  return (
    (path === `/etc/systemd/system/multi-user.target.wants/${signal.unit}` ||
      path ===
        `/etc/systemd/system/snapd.mounts.target.wants/${signal.unit}`) &&
    mode === "0777" &&
    type === "symlink" &&
    sha256 == null
  );
}

function isVerifiedSnapMountAddition({
  category,
  value,
  delta,
  installedUnits,
}: {
  category: "persistence.files" | "services.enabled";
  value: string;
  delta: HostIntrusionSnapshotDelta;
  installedUnits: Set<string>;
}): boolean {
  const signal = snapRevisionSignal(category, value);
  return (
    signal != null &&
    installedUnits.has(signal.unit) &&
    isStructurallyValidSnapMountAddition({ category, value, delta })
  );
}

function routineSnapRevisionChanges(
  delta: HostIntrusionSnapshotDelta,
  installedSnapMountUnits: string[] = [],
  baselineSnapshots: NormalizedHostIntrusionSnapshot[] = [],
): {
  added: Set<string>;
  removed: Set<string>;
} {
  const routine = { added: new Set<string>(), removed: new Set<string>() };
  const installedUnits = new Set(installedSnapMountUnits);
  const baselineIdentities = baselineSnapMountIdentities(baselineSnapshots);
  for (const category of ["persistence.files", "services.enabled"] as const) {
    const removedByKey = new Map<string, Array<[string, string]>>();
    for (const value of delta.removed[category] ?? []) {
      const signal = snapRevisionSignal(category, value);
      if (!signal) continue;
      const values = removedByKey.get(signal.key) ?? [];
      values.push([signal.revision, value]);
      removedByKey.set(signal.key, values);
    }
    for (const value of delta.added[category] ?? []) {
      const signal = snapRevisionSignal(category, value);
      if (!signal || !baselineIdentities.has(signal.identity)) continue;
      if (
        !isVerifiedSnapMountAddition({
          category,
          value,
          delta,
          installedUnits,
        })
      ) {
        continue;
      }
      const candidates = removedByKey.get(signal.key);
      const matchIndex =
        candidates?.findIndex(([revision]) => revision !== signal.revision) ??
        -1;
      if (!candidates || matchIndex < 0) continue;
      const [[, removed]] = candidates.splice(matchIndex, 1);
      routine.added.add(value);
      routine.removed.add(removed);
    }
    for (const value of delta.added[category] ?? []) {
      const signal = snapRevisionSignal(category, value);
      if (!signal || !baselineIdentities.has(signal.identity)) continue;
      if (
        isVerifiedSnapMountAddition({
          category,
          value,
          delta,
          installedUnits,
        })
      ) {
        routine.added.add(value);
      }
    }
  }
  return routine;
}

function snapRefreshFingerprint(
  delta: HostIntrusionSnapshotDelta,
  units: string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ delta, units }))
    .digest("hex");
}

export function snapRefreshConfirmationCandidate(
  delta: HostIntrusionSnapshotDelta,
  actionable: HostIntrusionSnapshotDelta,
  {
    installedSnapMountUnits,
    baselineSnapshots,
    persistenceFiles,
    trustedAdminSshSources = [],
  }: {
    installedSnapMountUnits: string[] | undefined;
    baselineSnapshots: NormalizedHostIntrusionSnapshot[];
    persistenceFiles: HostIntrusionSnapshotResponse["persistence"]["files"];
    trustedAdminSshSources?: string[];
  },
): SnapRefreshConfirmationCandidate | undefined {
  // An omitted attestation field means an old collector, not a transient race.
  if (installedSnapMountUnits == null) return;
  if (!hasHostIntrusionSnapshotChanges(actionable)) return;

  const installedUnits = new Set(installedSnapMountUnits);
  const baselineIdentities = baselineSnapMountIdentities(baselineSnapshots);
  const units = sortedUnique(
    (delta.added["services.enabled"] ?? []).flatMap((value) => {
      const signal = snapRevisionSignal("services.enabled", value);
      if (
        !signal ||
        value !== `${signal.unit} enabled enabled` ||
        installedUnits.has(signal.unit) ||
        !baselineIdentities.has(signal.identity)
      ) {
        return [];
      }
      return [signal.unit];
    }),
  );
  if (!units.length) return;

  for (const unit of units) {
    const persistence = (delta.added["persistence.files"] ?? []).filter(
      (value) => snapRevisionSignal("persistence.files", value)?.unit === unit,
    );
    if (persistence.length !== 3) return;
    const paths = new Set(
      persistence.map((value) => decodeSignal(value)?.[0]).filter(Boolean),
    );
    if (
      !paths.has(`/etc/systemd/system/${unit}`) ||
      !paths.has(`/etc/systemd/system/multi-user.target.wants/${unit}`) ||
      !paths.has(`/etc/systemd/system/snapd.mounts.target.wants/${unit}`) ||
      persistence.some(
        (value) =>
          !isStructurallyValidSnapMountAddition({
            category: "persistence.files",
            value,
            delta,
          }),
      )
    ) {
      return;
    }
    for (const target of [
      "multi-user.target.wants",
      "snapd.mounts.target.wants",
    ]) {
      const path = `/etc/systemd/system/${target}/${unit}`;
      const raw = persistenceFiles.find((entry) => entry.path === path);
      if (raw?.link_target !== `/etc/systemd/system/${unit}`) return;
    }
  }

  // Prove that active-mount attestation is the only reason this sample would
  // alert. Any unrelated or malformed change remains immediately actionable.
  const actionableIfMounted = selectActionableHostIntrusionChanges(delta, {
    installedSnapMountUnits: sortedUnique([
      ...installedSnapMountUnits,
      ...units,
    ]),
    baselineSnapshots,
    trustedAdminSshSources,
  });
  if (hasHostIntrusionSnapshotChanges(actionableIfMounted)) return;
  return {
    units,
    fingerprint: snapRefreshFingerprint(actionable, units),
  };
}

function monitoredSignals(
  snapshot: NormalizedHostIntrusionSnapshot,
  category: MonitoredCategory,
): string[] {
  // Preserve raw evidence in the snapshot; remove noise only while comparing.
  const values = snapshot.signals[category] ?? [];
  if (category === "host_processes.summary") {
    return values.filter((value) => !isExpectedTransientProcess(value));
  }
  if (category === "network.listeners") {
    return sortedUnique(values.map(canonicalizeListener));
  }
  return values;
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
          "cgroup",
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
        .filter(([name]) => !NON_INTRUSION_KERNEL_SIGNALS.has(name))
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
    const before = new Set(monitoredSignals(previous, category));
    const after = new Set(monitoredSignals(current, category));
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

export function selectActionableHostIntrusionChanges(
  delta: HostIntrusionSnapshotDelta,
  {
    installedSnapMountUnits = [],
    baselineSnapshots = [],
    trustedAdminSshSources = [],
  }: {
    installedSnapMountUnits?: string[];
    baselineSnapshots?: NormalizedHostIntrusionSnapshot[];
    trustedAdminSshSources?: string[];
  } = {},
): HostIntrusionSnapshotDelta {
  const actionable: HostIntrusionSnapshotDelta = { added: {}, removed: {} };
  const trustedAdminSshSourceSet = new Set(trustedAdminSshSources);
  const routineSnap = routineSnapRevisionChanges(
    delta,
    installedSnapMountUnits,
    baselineSnapshots,
  );
  for (const [category, values] of Object.entries(delta.added) as Array<
    [MonitoredCategory, string[]]
  >) {
    if (!ACTIONABLE_ADDITIONS.has(category)) continue;
    const relevant = values.filter((value) => !routineSnap.added.has(value));
    const filtered =
      category === "network.listeners"
        ? relevant.filter(isActionableListener)
        : category === "authentication_7d.accepted"
          ? relevant.filter((value) =>
              isActionableAuthentication(value, trustedAdminSshSourceSet),
            )
          : relevant;
    if (filtered.length) actionable.added[category] = filtered;
  }
  for (const [category, values] of Object.entries(delta.removed) as Array<
    [MonitoredCategory, string[]]
  >) {
    if (!ACTIONABLE_REMOVALS.has(category)) continue;
    const relevant = values.filter((value) => !routineSnap.removed.has(value));
    if (relevant.length) {
      actionable.removed[category] = relevant;
    }
  }
  return actionable;
}

function transitionAlertMode(): TransitionAlertMode {
  // `off` keeps collection and coverage alerts; `all` is useful for diagnosis.
  const configured = process.env.COCALC_HOST_INTRUSION_MONITOR_ALERT_MODE;
  if (configured == null || configured === "") return "actionable";
  if (
    configured === "actionable" ||
    configured === "all" ||
    configured === "off"
  ) {
    return configured;
  }
  logger.warn("invalid project-host intrusion monitor alert mode", {
    configured,
    fallback: "actionable",
  });
  return "actionable";
}

export function diffHostIntrusionSnapshotAgainstFleet(
  fleet: NormalizedHostIntrusionSnapshot[],
  current: NormalizedHostIntrusionSnapshot,
): HostIntrusionSnapshotDelta {
  const added: HostIntrusionSnapshotDelta["added"] = {};
  for (const category of MONITORED_CATEGORIES) {
    const observed = new Set(
      fleet.flatMap((snapshot) => monitoredSignals(snapshot, category)),
    );
    const newValues = monitoredSignals(current, category).filter(
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
          monitoredSignals(snapshot, category),
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
        collector_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        assessment JSONB NOT NULL DEFAULT '{"state":"observed"}'::jsonb,
        baseline_eligible BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (coverage IN ('complete', 'partial', 'unavailable'))
      )
    `);
    await pool.query(`
      ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS collector_evidence JSONB NOT NULL
          DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS assessment JSONB NOT NULL
          DEFAULT '{"state":"observed"}'::jsonb,
        ADD COLUMN IF NOT EXISTS baseline_eligible BOOLEAN NOT NULL DEFAULT TRUE
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
        AND baseline_eligible
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
        AND snapshots.baseline_eligible
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
          AND snapshots.baseline_eligible
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

async function loadPendingSnapRefresh(
  hostId: string,
): Promise<PendingSnapRefreshRow | undefined> {
  const { rows } = await getPool().query<PendingSnapRefreshRow>(
    `
      SELECT id, assessment
      FROM ${TABLE} AS pending
      WHERE pending.host_id = $1
        AND pending.coverage = 'complete'
        AND NOT pending.baseline_eligible
        AND pending.assessment->>'state' = 'pending_snap_refresh_confirmation'
        AND NOT EXISTS (
          SELECT 1
          FROM ${TABLE} AS accepted
          WHERE accepted.host_id = pending.host_id
            AND accepted.coverage = 'complete'
            AND accepted.baseline_eligible
            AND accepted.created_at > pending.created_at
        )
      ORDER BY pending.created_at DESC
      LIMIT 1
    `,
    [hostId],
  );
  return rows[0];
}

async function countPendingSnapRefreshes(bayId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM ${TABLE} AS pending
      INNER JOIN project_hosts AS hosts ON hosts.id = pending.host_id
      WHERE pending.bay_id = $1
        AND pending.coverage = 'complete'
        AND NOT pending.baseline_eligible
        AND pending.assessment->>'state' = 'pending_snap_refresh_confirmation'
        AND hosts.deleted IS NULL
        AND hosts.status = 'running'
        AND hosts.last_seen >= NOW() - ($2::double precision * INTERVAL '1 millisecond')
        AND COALESCE(NULLIF(hosts.bay_id, ''), $1) = $1
        AND NOT EXISTS (
          SELECT 1
          FROM ${TABLE} AS accepted
          WHERE accepted.host_id = pending.host_id
            AND accepted.coverage = 'complete'
            AND accepted.baseline_eligible
            AND accepted.created_at > pending.created_at
        )
    `,
    [bayId, HOST_ONLINE_WINDOW_MS],
  );
  return Number(rows[0]?.count ?? 0);
}

async function persistSnapshot({
  hostId,
  bayId,
  source,
  normalized,
  delta,
  assessment = { state: "observed" },
  baselineEligible = true,
}: PersistSnapshotOptions): Promise<void> {
  await getPool().query(
    `
      INSERT INTO ${TABLE} (
        id, host_id, bay_id, captured_at, duration_ms, coverage,
        normalization_version, fingerprint, normalized, delta,
        collector_evidence, assessment, baseline_eligible
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
        $11::jsonb, $12::jsonb, $13
      )
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
      JSON.stringify({
        collector_version: source.version,
        snap_mount_units: source.snap_mount_units ?? null,
        persistence_symlinks: source.persistence.files
          .filter(({ type }) => type === "symlink")
          .map(({ path, link_target }) => ({
            path,
            link_target: link_target ?? null,
          })),
        issues: source.issues,
        truncated: source.truncated,
        persistence_truncated: source.persistence.truncated,
      }),
      JSON.stringify(assessment),
      baselineEligible,
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
    `${transitions.length} project host${transitions.length === 1 ? " has" : "s have"} actionable security-state changes relative to an available host or fleet baseline.`,
    "",
    "This monitor is report-only. Lower-confidence operational changes remain recorded in the snapshot history but do not trigger notifications. Review each listed change and run a fresh admin host intrusion-snapshot when deeper evidence is needed.",
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

function requireCgroupAwareCollector(
  source: HostIntrusionSnapshotResponse,
): HostIntrusionSnapshotResponse {
  if (source.version >= 2) return source;
  return {
    ...source,
    coverage: source.coverage === "unavailable" ? "unavailable" : "partial",
    issues: [
      ...source.issues,
      { section: "host_processes", code: "CGROUP_COVERAGE_UNAVAILABLE" },
    ],
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
    pending: 0,
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
  const alertMode = transitionAlertMode();
  const trustedAdminSshSources = configuredTrustedAdminSshSources(bayId);

  await mapWithConcurrency(hosts, concurrency, async (host) => {
    result.checked += 1;
    try {
      const previousCoverage = await loadRecentCoverage(host.id);
      const source = requireCgroupAwareCollector(
        await (
          await getRoutedHostControlClient({
            host_id: host.id,
            timeout: HOST_RPC_TIMEOUT_MS,
            fresh: true,
          })
        ).getIntrusionSnapshot(),
      );
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

      const [previous, pendingSnapRefresh] = await Promise.all([
        loadPreviousCompleteSnapshot(host.id),
        loadPendingSnapRefresh(host.id),
      ]);
      let delta: HostIntrusionSnapshotDelta | undefined;
      let baselineSnapshots: NormalizedHostIntrusionSnapshot[] = [];
      let baseline: HostTransition["baseline"] = "host";
      let comparedWithFleet = false;
      if (previous) {
        baselineSnapshots = [previous];
        delta = diffHostIntrusionSnapshots(previous, normalized);
      } else if (hadActiveFleetBaseline) {
        const fleet = await loadFleetCompleteSnapshots({
          bayId,
          excludeHostId: host.id,
        });
        if (fleet.length) {
          baselineSnapshots = fleet;
          delta = diffHostIntrusionSnapshotAgainstFleet(fleet, normalized);
          baseline = "fleet";
          comparedWithFleet = true;
        }
      }
      const alertDelta =
        delta == null || alertMode === "off"
          ? undefined
          : alertMode === "all"
            ? delta
            : selectActionableHostIntrusionChanges(delta, {
                installedSnapMountUnits: source.snap_mount_units,
                baselineSnapshots,
                trustedAdminSshSources,
              });
      let changedDelta =
        alertDelta != null && hasHostIntrusionSnapshotChanges(alertDelta)
          ? alertDelta
          : undefined;
      const snapRefreshCandidate =
        alertMode === "actionable" && delta != null && changedDelta != null
          ? snapRefreshConfirmationCandidate(delta, changedDelta, {
              installedSnapMountUnits: source.snap_mount_units,
              baselineSnapshots,
              persistenceFiles: source.persistence.files,
              trustedAdminSshSources,
            })
          : undefined;
      let assessment: SnapshotAssessment = { state: "observed" };
      let baselineEligible = true;
      if (snapRefreshCandidate) {
        if (pendingSnapRefresh == null) {
          assessment = {
            state: "pending_snap_refresh_confirmation",
            ...snapRefreshCandidate,
          };
          baselineEligible = false;
          changedDelta = undefined;
          result.pending += 1;
        } else if (
          pendingSnapRefresh.assessment.fingerprint ===
          snapRefreshCandidate.fingerprint
        ) {
          assessment = {
            state: "notified_snap_refresh_confirmation",
            pending_snapshot_id: pendingSnapRefresh.id,
            ...snapRefreshCandidate,
          };
        }
      } else if (pendingSnapRefresh && changedDelta == null) {
        const installedUnits = new Set(source.snap_mount_units ?? []);
        assessment = {
          state: "resolved_snap_refresh_confirmation",
          pending_snapshot_id: pendingSnapRefresh.id,
          fingerprint: pendingSnapRefresh.assessment.fingerprint,
          resolution: pendingSnapRefresh.assessment.units.every((unit) =>
            installedUnits.has(unit),
          )
            ? "attested"
            : "reverted",
        };
      }
      const completeSnapshot = {
        hostId: host.id,
        bayId,
        source,
        normalized,
        delta,
        assessment,
        baselineEligible,
      };
      const needsInitialReview =
        alertMode !== "off" && !previous && !comparedWithFleet;
      // Do not promote a security baseline until its alert is accepted. If
      // delivery fails, the next pass compares against the older baseline and
      // retries rather than silently absorbing the transition.
      if (changedDelta || needsInitialReview) {
        deferredCompleteSnapshots.push(completeSnapshot);
      } else {
        await persistSnapshot(completeSnapshot);
      }
      if (!previous && baselineEligible) {
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
      subject:
        "Project host intrusion monitor detected actionable security-state changes",
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
  result.pending = await countPendingSnapRefreshes(bayId);

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
    if (result.pending > 0 && pendingConfirmationTimer == null) {
      const delayMs = envNumberAtLeast(
        "COCALC_HOST_INTRUSION_SNAP_CONFIRMATION_DELAY_MS",
        DEFAULT_SNAP_REFRESH_CONFIRMATION_DELAY_MS,
        MIN_SNAP_REFRESH_CONFIRMATION_DELAY_MS,
      );
      logger.info("scheduling snap refresh confirmation pass", {
        pending: result.pending,
        delay_ms: delayMs,
      });
      pendingConfirmationTimer = setTimeout(() => {
        pendingConfirmationTimer = undefined;
        void runLockedPass().catch((err) => {
          logger.error("project-host intrusion confirmation pass failed", err);
        });
      }, delayMs);
      pendingConfirmationTimer.unref?.();
    }
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
    alert_mode: transitionAlertMode(),
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
