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
  const reasonUnavailable = `${read(hostInfo, "reason_unavailable") ?? ""}`.trim();
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
  const availability = evaluateHostOperational(hostInfo);
  if (availability.state === "unavailable") {
    return "opened";
  }
  return state;
}
