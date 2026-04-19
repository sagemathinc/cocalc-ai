import type { HubApi } from "@cocalc/conat/hub/api";

export type LroStatusSummaryLike = {
  status?: string;
  error?: string | null;
};

export type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  result?: any;
  progress_summary?: any;
  timedOut?: boolean;
};

export type LroWaitUpdate = Pick<
  LroStatus,
  "op_id" | "status" | "error" | "result" | "progress_summary"
>;

export async function waitForLro({
  hub,
  opId,
  timeoutMs,
  pollMs,
  terminalStatuses,
  onUpdate,
}: {
  hub: Pick<HubApi, "lro">;
  opId: string;
  timeoutMs: number;
  pollMs: number;
  terminalStatuses: Set<string>;
  onUpdate?: (update: LroWaitUpdate) => void | Promise<void>;
}): Promise<LroStatus> {
  const started = Date.now();
  let lastStatus = "unknown";
  let lastError: string | null | undefined;
  let lastProgressKey = "";

  while (Date.now() - started <= timeoutMs) {
    const summary = (await hub.lro.get({ op_id: opId })) as
      | LroStatusSummaryLike
      | undefined;
    const status = summary?.status ?? "unknown";
    lastStatus = status;
    lastError = summary?.error;
    const snapshot: LroWaitUpdate = {
      op_id: opId,
      status,
      error: summary?.error ?? null,
      result: (summary as any)?.result,
      progress_summary: (summary as any)?.progress_summary,
    };
    const progressKey = JSON.stringify({
      status: snapshot.status,
      error: snapshot.error ?? null,
      progress_summary: snapshot.progress_summary ?? null,
    });
    if (progressKey !== lastProgressKey) {
      lastProgressKey = progressKey;
      await onUpdate?.(snapshot);
    }

    if (terminalStatuses.has(status)) {
      return {
        op_id: opId,
        status,
        error: summary?.error ?? null,
        result: (summary as any)?.result,
        progress_summary: (summary as any)?.progress_summary,
      };
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
