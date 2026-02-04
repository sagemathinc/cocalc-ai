import type { ConnectOptions, ConnectResult } from "./core";
import {
  connectSession,
  getRemoteStatus,
  listSessions,
  statusSession,
  updateRegistry,
} from "./core";

export type SshSessionRow = {
  target: string;
  localPort?: number;
  lastUsed?: string;
  lastStopped?: string;
  status?: string;
  tunnelActive?: boolean;
};

export type ConnectUiResult = {
  url: string;
  localPort: number;
  remotePort: number;
};

const activeTunnels = new Map<string, ConnectResult>();

function isTunnelActive(result?: ConnectResult) {
  if (!result) return false;
  return result.tunnel.exitCode == null && !result.tunnel.killed;
}

export async function listSessionsUI(opts?: {
  withStatus?: boolean;
}): Promise<SshSessionRow[]> {
  const entries = listSessions();
  const rows: SshSessionRow[] = [];
  for (const entry of entries) {
    const row: SshSessionRow = {
      target: entry.target,
      localPort: entry.localPort,
      lastUsed: entry.lastUsed,
      lastStopped: entry.lastStopped,
    };
    if (opts?.withStatus) {
      row.status = await getRemoteStatus(entry);
    }
    row.tunnelActive = isTunnelActive(activeTunnels.get(entry.target));
    rows.push(row);
  }
  return rows;
}

export async function connectSessionUI(
  target: string,
  options: ConnectOptions = {},
): Promise<ConnectUiResult> {
  const existing = activeTunnels.get(target);
  if (isTunnelActive(existing)) {
    return {
      url: existing?.url ?? "",
      localPort: existing?.localPort ?? 0,
      remotePort: existing?.remotePort ?? 0,
    };
  }
  const result = await connectSession(target, { ...options, noOpen: true });
  activeTunnels.set(target, result);
  result.tunnel.on("exit", () => {
    activeTunnels.delete(target);
  });
  return {
    url: result.url,
    localPort: result.localPort,
    remotePort: result.remotePort,
  };
}

export async function statusSessionUI(target: string): Promise<string> {
  const entry = listSessions().find((item) => item.target === target);
  if (!entry) {
    throw new Error(`Unknown target: ${target}`);
  }
  return await getRemoteStatus(entry);
}

export async function addSessionUI(target: string): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Target is required");
  }
  updateRegistry(trimmed, {});
}

export async function stopSessionUI(target: string): Promise<void> {
  const existing = activeTunnels.get(target);
  if (isTunnelActive(existing)) {
    existing?.tunnel.kill();
    activeTunnels.delete(target);
  }
  await statusSession("stop", target, {});
}
