import { COMPUTE_STATES } from "@cocalc/util/compute-states";

const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;

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
