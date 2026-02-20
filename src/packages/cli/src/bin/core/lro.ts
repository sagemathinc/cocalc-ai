import type { HubApi } from "@cocalc/conat/hub/api";

export type LroStatusSummaryLike = {
  status?: string;
  error?: string | null;
};

export type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  timedOut?: boolean;
};

export async function waitForLro({
  hub,
  opId,
  timeoutMs,
  pollMs,
  terminalStatuses,
}: {
  hub: Pick<HubApi, "lro">;
  opId: string;
  timeoutMs: number;
  pollMs: number;
  terminalStatuses: Set<string>;
}): Promise<LroStatus> {
  const started = Date.now();
  let lastStatus = "unknown";
  let lastError: string | null | undefined;

  while (Date.now() - started <= timeoutMs) {
    const summary = (await hub.lro.get({ op_id: opId })) as LroStatusSummaryLike | undefined;
    const status = summary?.status ?? "unknown";
    lastStatus = status;
    lastError = summary?.error;

    if (terminalStatuses.has(status)) {
      return { op_id: opId, status, error: summary?.error ?? null };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    op_id: opId,
    status: lastStatus,
    error: lastError,
    timedOut: true,
  };
}

export async function waitForProjectPlacement({
  projectId,
  hostId,
  timeoutMs,
  pollMs,
  getHostId,
}: {
  projectId: string;
  hostId: string;
  timeoutMs: number;
  pollMs: number;
  getHostId: (projectId: string) => Promise<string | null | undefined>;
}): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const currentHostId = await getHostId(projectId);
    if (currentHostId === hostId) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

export async function waitForWorkspaceNotRunning({
  projectId,
  timeoutMs,
  pollMs,
  getState,
}: {
  projectId: string;
  timeoutMs: number;
  pollMs: number;
  getState: (projectId: string) => Promise<string>;
}): Promise<{ ok: boolean; state: string }> {
  const started = Date.now();
  let lastState = "";
  while (Date.now() - started <= timeoutMs) {
    const state = await getState(projectId);
    lastState = state;
    if (state !== "running") {
      return { ok: true, state };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, state: lastState };
}
