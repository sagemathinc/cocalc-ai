import { COMPUTE_STATES } from "@cocalc/util/compute-states";

const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_RECOVERY_ESTIMATE_MS = 3 * 60 * 1000;
const STALE_OUTAGE_START_MS = 30 * 60 * 1000;
export const HOST_UNAVAILABLE_BANNER_GRACE_MS = 5_000;

type HostInfoLike = {
  get?: (key: string) => any;
  [key: string]: any;
};

export type HostOperationalState = {
  state: "operational" | "unavailable" | "unknown";
  status?: string;
  online?: boolean;
  reason?: string;
};

export type HostRecoveryDisplay = {
  active: boolean;
  // Replaces the generic banner headline and adds a short inline summary.
  headline?: string;
  summary?: string;
  title?: string;
  description?: string;
  etaMinutes?: number;
  startedAt?: string;
  timingDescription?: string;
};

export function expectsProjectHostConnection({
  projectState,
  runtimePreparing,
}: {
  projectState?: string;
  runtimePreparing: boolean;
}): boolean {
  return (
    `${projectState ?? ""}`.trim().toLowerCase() === "running" ||
    runtimePreparing
  );
}

function read(hostInfo: HostInfoLike | undefined, key: string): any {
  if (!hostInfo) return undefined;
  if (typeof hostInfo.get === "function") return hostInfo.get(key);
  return (hostInfo as any)[key];
}

function parseOnline(hostInfo: HostInfoLike | undefined): boolean | undefined {
  const explicit = read(hostInfo, "online");
  if (typeof explicit === "boolean") return explicit;
  const lastSeen = read(hostInfo, "last_seen");
  if (typeof lastSeen !== "string" || lastSeen.length === 0) return undefined;
  const ts = Date.parse(lastSeen);
  if (!Number.isFinite(ts)) return undefined;
  return Date.now() - ts <= HOST_ONLINE_WINDOW_MS;
}

function normalizeStatus(value: unknown): string | undefined {
  const status = `${value ?? ""}`.trim().toLowerCase();
  if (!status) return undefined;
  return status === "active" ? "running" : status;
}

function futureTimestamp(value: unknown, now = Date.now()): number | undefined {
  const timestamp = Date.parse(`${value ?? ""}`);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed = Date.parse(`${value ?? ""}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function hostUnavailableBannerDelay({
  candidate,
  recoveryActive,
  unavailableSince,
  now = Date.now(),
  graceMs = HOST_UNAVAILABLE_BANNER_GRACE_MS,
}: {
  candidate: boolean;
  recoveryActive: boolean;
  unavailableSince?: string;
  now?: number;
  graceMs?: number;
}): number | undefined {
  if (!candidate) return;
  if (recoveryActive) return 0;
  const unavailableAt = timestamp(unavailableSince);
  const elapsed = unavailableAt == null ? 0 : Math.max(0, now - unavailableAt);
  return Math.max(0, graceMs - elapsed);
}

export type HostMaintenanceDisplay = {
  state: "scheduled" | "in_progress" | "failed";
  kind: "relocation" | "maintenance";
  // Scheduled start, or when the window actually started.
  startsAt?: string;
  expectedEndAt?: string;
  expectedMinutes?: number;
  // Past the expected end (in progress) or past the scheduled start.
  overdue: boolean;
  message?: string;
};

function plain(value: any): any {
  return typeof value?.toJS === "function" ? value.toJS() : value;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getHostMaintenanceDisplay(
  hostInfo: HostInfoLike | undefined,
  now = Date.now(),
): HostMaintenanceDisplay | undefined {
  const notice = plain(read(hostInfo, "maintenance"));
  if (!notice || typeof notice !== "object") return undefined;
  const state = notice.state;
  if (state !== "scheduled" && state !== "in_progress" && state !== "failed") {
    return undefined;
  }
  const kind = notice.kind === "relocation" ? "relocation" : "maintenance";
  const startsAtMs = timestamp(
    state === "scheduled" ? notice.scheduled_for : notice.started_at,
  );
  const durationMs = Number(notice.expected_duration_ms);
  const expectedMinutes =
    Number.isFinite(durationMs) && durationMs > 0
      ? Math.max(1, Math.round(durationMs / 60_000))
      : undefined;
  const expectedEndMs =
    timestamp(notice.expected_end_at) ??
    (startsAtMs != null && expectedMinutes != null
      ? startsAtMs + durationMs
      : undefined);
  const overdue =
    state === "scheduled"
      ? startsAtMs != null && now > startsAtMs
      : expectedEndMs != null && now > expectedEndMs + 60_000;
  const message = `${notice.message ?? ""}`.trim();
  return {
    state,
    kind,
    ...(startsAtMs != null
      ? { startsAt: new Date(startsAtMs).toISOString() }
      : {}),
    ...(expectedEndMs != null
      ? { expectedEndAt: new Date(expectedEndMs).toISOString() }
      : {}),
    ...(expectedMinutes != null ? { expectedMinutes } : {}),
    overdue,
    ...(message ? { message } : {}),
  };
}

function maintenanceRecoveryDisplay(
  maintenance: HostMaintenanceDisplay,
  now: number,
): HostRecoveryDisplay {
  const endMs = timestamp(maintenance.expectedEndAt);
  const minutes = maintenance.expectedMinutes;
  const timingDescription =
    maintenance.state === "failed" || maintenance.overdue
      ? "This is taking longer than expected. CoCalc staff have been notified, and your saved files are safe."
      : endMs != null
        ? `Expected back around ${clockTime(endMs)}${
            minutes ? ` (the whole window is about ${minutes} minute${minutes === 1 ? "" : "s"})` : ""
          }.`
        : "It should be back shortly.";
  return {
    active: true,
    headline: "Down for scheduled maintenance",
    summary:
      maintenance.state === "failed" || maintenance.overdue
        ? "Taking longer than expected"
        : endMs != null
          ? `Expected back around ${clockTime(endMs)}`
          : undefined,
    title:
      maintenance.state === "failed"
        ? "Scheduled maintenance is taking longer than planned"
        : "This project's server is down for scheduled maintenance",
    description:
      maintenance.kind === "relocation"
        ? "CoCalc is moving the server that runs this project to a new machine. Your files, snapshots and settings move with it."
        : "CoCalc is doing scheduled maintenance on the server that runs this project.",
    ...(endMs != null
      ? { etaMinutes: Math.max(1, Math.ceil((endMs - now) / 60_000)) }
      : {}),
    ...(maintenance.startsAt ? { startedAt: maintenance.startsAt } : {}),
    timingDescription,
  };
}

export function getHostRecoveryDisplay(
  hostInfo: HostInfoLike | undefined,
  now = Date.now(),
  clientUnavailableSince?: string,
): HostRecoveryDisplay {
  const maintenance = getHostMaintenanceDisplay(hostInfo, now);
  if (maintenance && maintenance.state !== "scheduled") {
    return maintenanceRecoveryDisplay(maintenance, now);
  }
  const recovery = read(hostInfo, "spot_recovery_state");
  const phase = `${
    read(hostInfo, "recovery_phase") ?? read(recovery, "phase") ?? ""
  }`.trim();
  const desiredState = `${read(hostInfo, "desired_state") ?? "running"}`;
  const recoveryActive =
    !!phase && phase !== "idle" && desiredState === "running";
  const desiredPricing = `${
    read(hostInfo, "desired_pricing_model") ??
    read(hostInfo, "pricing_model") ??
    ""
  }`;
  const isSpotRecovery = recoveryActive && desiredPricing === "spot";
  const effectivePricing = `${
    read(hostInfo, "effective_pricing_model") ?? desiredPricing
  }`;
  const machine = read(hostInfo, "machine");
  const desiredMachineType = `${read(machine, "machine_type") ?? ""}`.trim();
  const activeMachineType = `${
    read(recovery, "active_machine_type") ?? desiredMachineType
  }`.trim();
  const nextRetry = futureTimestamp(read(recovery, "next_retry_at"), now);
  const etaMinutes = nextRetry
    ? Math.max(2, Math.ceil((nextRetry - now) / 60_000) + 2)
    : 3;
  const lastSeenMs = timestamp(read(hostInfo, "last_seen"));
  const clientStartedAtMs = timestamp(clientUnavailableSince);
  // The replacement VM heartbeats before recovery finishes, so last_seen
  // passes the outage start while the banner is still up: that must not hide
  // when the outage started. An outage start much older than the current
  // start attempt (e.g. a restart during a Standard hold) is stale.
  const outageStartedAtMs = isSpotRecovery
    ? timestamp(read(recovery, "outage_started_at"))
    : undefined;
  const attemptStartedAtMs = isSpotRecovery
    ? timestamp(read(recovery, "verification_started_at"))
    : undefined;
  let spotStartedAtMs = outageStartedAtMs ?? attemptStartedAtMs;
  if (
    outageStartedAtMs != null &&
    attemptStartedAtMs != null &&
    attemptStartedAtMs - outageStartedAtMs > STALE_OUTAGE_START_MS
  ) {
    spotStartedAtMs = attemptStartedAtMs;
  }
  if (
    spotStartedAtMs != null &&
    attemptStartedAtMs == null &&
    lastSeenMs != null &&
    spotStartedAtMs < lastSeenMs &&
    now - spotStartedAtMs > STALE_OUTAGE_START_MS
  ) {
    spotStartedAtMs = undefined;
  }
  const serverStartedAtCandidates = [
    ...(spotStartedAtMs != null ? [spotStartedAtMs] : []),
    ...[timestamp(read(hostInfo, "unavailable_since"))].filter(
      (value) => value != null && (lastSeenMs == null || value >= lastSeenMs),
    ),
  ].filter((value): value is number => value != null && value <= now);
  // Once this browser witnesses a disconnect, its timestamp is the stable
  // identity of this incident. Provider recovery state can retain an older
  // outage while a Standard fallback hold remains active; accepting that value
  // later would make the displayed elapsed time jump backwards by hours.
  const startedAtMs =
    clientStartedAtMs != null && clientStartedAtMs <= now
      ? clientStartedAtMs
      : serverStartedAtCandidates.length > 0
        ? Math.min(...serverStartedAtCandidates)
        : undefined;
  const historicalEstimate = Number(
    read(hostInfo, "recovery_duration_estimate_ms"),
  );
  const estimatedDurationMs =
    Number.isFinite(historicalEstimate) && historicalEstimate > 0
      ? historicalEstimate
      : DEFAULT_RECOVERY_ESTIMATE_MS;
  const elapsedMs =
    startedAtMs == null ? undefined : Math.max(0, now - startedAtMs);
  const estimatedMinutes = Math.max(
    1,
    Math.round(estimatedDurationMs / 60_000),
  );
  const timingDescription =
    elapsedMs != null && elapsedMs > estimatedDurationMs
      ? `This is taking longer than the usual ${estimatedMinutes} minute${estimatedMinutes === 1 ? "" : "s"}, but CoCalc is still retrying automatically.`
      : `This usually takes about ${estimatedMinutes} minute${estimatedMinutes === 1 ? "" : "s"}, though cloud capacity can make it longer.`;
  const timing = {
    etaMinutes,
    ...(startedAtMs == null
      ? {}
      : {
          startedAt: new Date(startedAtMs).toISOString(),
        }),
    timingDescription,
  };

  if (!isSpotRecovery && startedAtMs == null) {
    return { active: false };
  }
  if (!isSpotRecovery) {
    return { active: false, ...timing };
  }

  if (
    effectivePricing === "on_demand" ||
    phase === "running_standard_fallback"
  ) {
    return {
      active: true,
      title: "Project host is restarting on guaranteed capacity",
      description:
        "Spot capacity was not available, so CoCalc switched this host to Standard capacity and is reconnecting projects automatically.",
      ...timing,
    };
  }
  if (
    activeMachineType &&
    desiredMachineType &&
    activeMachineType !== desiredMachineType
  ) {
    return {
      active: true,
      title: "Project host is restarting on alternate Spot capacity",
      description: `The cloud provider interrupted this Spot VM. CoCalc is now trying ${activeMachineType} after ${desiredMachineType} was unavailable.`,
      ...timing,
    };
  }
  return {
    active: true,
    title: "Project host is restarting automatically",
    description:
      "The cloud provider interrupted this Spot VM. CoCalc detected the shutdown and is restarting the host and its projects automatically.",
    ...timing,
  };
}

type ComputeStateName = keyof typeof COMPUTE_STATES;
export type ProjectLifecycleDisplayState = ComputeStateName | "new";
export type IndexedBackupState = "present" | "missing" | "unknown";
export type ProjectLifecycleKind = ComputeStateName | "new" | "unknown";
export type ProjectLifecycleView = {
  rawState?: ComputeStateName;
  displayState?: ProjectLifecycleDisplayState;
  backupState: IndexedBackupState;
  kind: ProjectLifecycleKind;
  isRawArchived: boolean;
  isRunning: boolean;
  isNew: boolean;
  isArchived: boolean;
  isArchivedLike: boolean;
  showLifecycleBanner: boolean;
  canShowFilesystem: boolean;
  shouldRestoreTabs: boolean;
  shouldForceHomeTab: boolean;
};

function asComputeState(value: unknown): ComputeStateName | undefined {
  const state = `${value ?? ""}`.trim();
  if (!state) return undefined;
  if (!Object.prototype.hasOwnProperty.call(COMPUTE_STATES, state)) {
    return undefined;
  }
  return state as ComputeStateName;
}

export function evaluateHostOperational(
  hostInfo: HostInfoLike | undefined,
): HostOperationalState {
  if (!hostInfo) {
    return { state: "unknown" };
  }
  const reasonUnavailable =
    `${read(hostInfo, "reason_unavailable") ?? ""}`.trim();
  if (reasonUnavailable) {
    return { state: "unavailable", reason: reasonUnavailable };
  }
  const status = normalizeStatus(read(hostInfo, "status"));
  const online = parseOnline(hostInfo);
  if (!status || online == null) {
    return { state: "unknown", status, online };
  }
  if (status !== "running") {
    return {
      state: "unavailable",
      status,
      online,
      reason: `Assigned host is ${status}.`,
    };
  }
  if (!online) {
    return {
      state: "unavailable",
      status,
      online,
      reason: "Assigned host is offline (stale heartbeat).",
    };
  }
  return { state: "operational", status, online };
}

export function isHostRecoveryTransient(
  hostInfo: HostInfoLike | undefined,
): boolean {
  const status = normalizeStatus(read(hostInfo, "status"));
  const desiredState = normalizeStatus(read(hostInfo, "desired_state"));
  const recovery = read(hostInfo, "spot_recovery_state");
  const phase = `${
    read(hostInfo, "recovery_phase") ?? read(recovery, "phase") ?? ""
  }`.trim();
  const recoveryActive = phase.length > 0 && phase !== "idle";
  const maintenance = getHostMaintenanceDisplay(hostInfo);
  if (maintenance && maintenance.state !== "scheduled") return true;

  if (status === "starting") return true;
  if (desiredState !== "running") return false;
  return (
    recoveryActive || status === "running" || status === "off" || status == null
  );
}

export function hostLabel(
  hostInfo: HostInfoLike | undefined,
  fallbackHostId?: string,
): string {
  const name = `${read(hostInfo, "name") ?? ""}`.trim();
  if (name) return name;
  return fallbackHostId ?? "assigned host";
}

export function normalizeProjectStateForDisplay({
  projectState,
  hostId,
  hostInfo,
}: {
  projectState?: unknown;
  hostId?: string | null;
  hostInfo?: HostInfoLike;
}): ComputeStateName | undefined {
  const state = asComputeState(projectState);
  if (!state) return undefined;
  if (state !== "running" || !hostId) return state;
  const hostStatus = normalizeStatus(read(hostInfo, "status"));
  // A stale/missing host heartbeat should not make a definitely running
  // project appear stopped in the UI. Reserve the downgrade for explicit
  // non-running host states such as off/error/deleted.
  if (hostStatus && hostStatus !== "running") {
    return "opened";
  }
  return state;
}

export function indexedBackupState(lastBackup: unknown): IndexedBackupState {
  if (typeof lastBackup === "undefined") {
    return "unknown";
  }
  if (lastBackup instanceof Date) {
    return Number.isFinite(lastBackup.valueOf()) ? "present" : "missing";
  }
  if (typeof lastBackup === "string") {
    return lastBackup.trim().length > 0 &&
      Number.isFinite(Date.parse(lastBackup))
      ? "present"
      : "missing";
  }
  if (lastBackup == null) {
    return "missing";
  }
  return "unknown";
}

export function getProjectLifecycleView({
  projectState,
  hostId,
  hostInfo,
  lastBackup,
}: {
  projectState?: unknown;
  hostId?: string | null;
  hostInfo?: HostInfoLike;
  lastBackup?: unknown;
}): ProjectLifecycleView {
  const rawState = normalizeProjectStateForDisplay({
    projectState,
    hostId,
    hostInfo,
  });
  const backupState = indexedBackupState(lastBackup);
  let displayState: ProjectLifecycleDisplayState | undefined = rawState;
  if (rawState === "archived") {
    if (backupState === "present") {
      displayState = "archived";
    } else if (backupState === "missing") {
      displayState = "new";
    } else {
      displayState = undefined;
    }
  }
  const isRawArchived = rawState === "archived";
  const kind =
    displayState ??
    (isRawArchived && backupState === "unknown"
      ? "unknown"
      : (rawState ?? "unknown"));
  const isNew = displayState === "new";
  const isArchived = displayState === "archived";
  const isArchivedLike = isRawArchived || isNew;
  const isRunning = kind === "running";
  const canShowFilesystem = !isArchivedLike;
  return {
    rawState,
    displayState,
    backupState,
    kind,
    isRawArchived,
    isRunning,
    isNew,
    isArchived,
    isArchivedLike,
    showLifecycleBanner: !isRunning,
    canShowFilesystem,
    shouldRestoreTabs: canShowFilesystem,
    shouldForceHomeTab: !canShowFilesystem,
  };
}

export function getProjectLifecycleDisplayState(args: {
  projectState?: unknown;
  hostId?: string | null;
  hostInfo?: HostInfoLike;
  lastBackup?: unknown;
}): ProjectLifecycleDisplayState | undefined {
  return getProjectLifecycleView(args).displayState;
}
