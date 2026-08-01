// Handles reporting project state from a project-host to the master. We send
// state updates immediately on change, serialize and briefly retry each
// project's newest state, then retain a 15s reconciliation scan for outages or
// process restarts. This prevents delayed starting reports from racing newer
// running reports while keeping the master view convergent during disconnects.
import type { Client } from "@cocalc/conat/core/client";
import getLogger from "@cocalc/backend/logger";
import { clearLocalAcpAutomationsForProject } from "@cocalc/lite/hub/acp";
import {
  createHostStatusClient,
  type HostStatusApi,
  type HostProjectStatus,
} from "@cocalc/conat/project-host/api";
import {
  listUnreportedProjects,
  markProjectStateReported,
} from "./sqlite/projects";
import {
  listUnreportedProvisioning,
  markProjectProvisionedReported,
  setProjectProvisioned,
  deleteProjectProvisioning,
} from "./sqlite/provisioning";
import { reportPendingProjectTouches } from "./last-edited";
import {
  getRevocationSyncCursor,
  setRevocationSyncCursor,
  upsertAccountRevocation,
} from "./sqlite/account-revocations";
import { deleteProjectLocal } from "./sqlite/projects";
import { deleteVolume } from "./file-server";
import { recordProjectHostRpcTraffic } from "./rpc-traffic-audit";
import { setProjectStateReporter } from "./project-state-reporter";
import { withBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";

let statusClient: HostStatusApi | undefined;
let hostInfo: Pick<HostProjectStatus, "host_id" | "host"> | undefined;
const logger = getLogger("project-host:master-status");
let resendTimer: NodeJS.Timeout | undefined;
let masterClient: Client | undefined;
const PROJECT_STATE_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
interface ProjectStateReportQueue {
  pending?: HostProjectStatus["state"];
  activeKey?: string;
  drain?: Promise<void>;
  wakeRetry?: () => void;
}
const projectStateReportQueues = new Map<string, ProjectStateReportQueue>();
let pendingInventory: { project_ids: string[]; checked_at: number } | null =
  null;
const DEFAULT_PROVISIONED_INVENTORY_INTERVAL_MS = 5 * 60 * 1000;
const pendingProjectDeletions = new Map<string, number>();
let projectDeletionWorkerRunning = false;

function provisionedInventoryIntervalMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_HOST_INVENTORY_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PROVISIONED_INVENTORY_INTERVAL_MS;
  }
  return Math.max(60_000, Math.floor(raw));
}

async function deleteProjectDataLocal(project_id: string) {
  await deleteVolume(project_id, { reportProvisioned: false });
  try {
    clearLocalAcpAutomationsForProject(project_id);
  } catch (err) {
    logger.debug("clearLocalAcpAutomationsForProject failed", {
      project_id,
      err,
    });
  }
  try {
    deleteProjectLocal(project_id);
  } catch (err) {
    logger.debug("deleteProjectLocal failed", { project_id, err });
  }
  try {
    deleteProjectProvisioning(project_id);
  } catch (err) {
    logger.debug("deleteProjectProvisioning failed", { project_id, err });
  }
}

function queueProjectDataDeletion(project_id: string): void {
  if (!pendingProjectDeletions.has(project_id)) {
    pendingProjectDeletions.set(project_id, 0);
  }
  void drainProjectDataDeletions();
}

async function drainProjectDataDeletions(): Promise<void> {
  if (projectDeletionWorkerRunning) return;
  projectDeletionWorkerRunning = true;
  try {
    while (pendingProjectDeletions.size > 0) {
      const entry = pendingProjectDeletions.entries().next().value as
        | [string, number]
        | undefined;
      if (!entry) break;
      const [project_id, attempts] = entry;
      try {
        await withBtrfsMutationContext(
          {
            operation_id: `stale-project-delete:${project_id}`,
            project_id,
            priority: "scavenger",
            operation_class: "stale_project_cleanup",
          },
          async () => await deleteProjectDataLocal(project_id),
        );
        pendingProjectDeletions.delete(project_id);
      } catch (err) {
        const nextAttempts = attempts + 1;
        pendingProjectDeletions.set(project_id, nextAttempts);
        logger.warn("stale project data deletion failed", {
          project_id,
          attempts: nextAttempts,
          err: `${err}`,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(30_000, 250 * 2 ** attempts)),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    projectDeletionWorkerRunning = false;
  }
}

export function setMasterStatusClient({
  client,
  host_id,
  host,
}: {
  client: Client;
  host_id: string;
  host?: HostProjectStatus["host"];
}) {
  statusClient = createHostStatusClient({ client });
  masterClient = client;
  hostInfo = { host_id, host };
  reportPendingStates().catch((err) =>
    logger.debug("reportPendingStates initial send failed", { err }),
  );
  if (!resendTimer) {
    resendTimer = setInterval(reportPendingStates, 15_000).unref();
  }
}

export function getMasterConatClient(): Client | undefined {
  return masterClient;
}

export function setMasterConatClient(client: Client | undefined): void {
  masterClient = client;
}

export async function reportProjectStateToMaster(
  project_id: string,
  state: HostProjectStatus["state"],
): Promise<void> {
  const normalized = normalizeReportedProjectState(state);
  let queue = projectStateReportQueues.get(project_id);
  if (!queue) {
    queue = {};
    projectStateReportQueues.set(project_id, queue);
  }
  const key = projectStateReportKey(normalized);
  if (queue.activeKey !== key) {
    queue.pending = normalized;
  }
  queue.wakeRetry?.();
  if (!queue.drain) {
    queue.drain = drainProjectStateReports(project_id, queue).finally(() => {
      projectStateReportQueues.delete(project_id);
    });
  }
  await queue.drain;
}

function normalizeReportedProjectState(
  state: HostProjectStatus["state"],
): HostProjectStatus["state"] {
  if (typeof state === "string") {
    return { state: state as any, time: new Date() };
  }
  return state.time == null ? { ...state, time: new Date() } : state;
}

function projectStateReportKey(state: HostProjectStatus["state"]): string {
  if (typeof state === "string") return state;
  return `${state.state ?? ""}:${state.runtime_exit_reason ?? ""}`;
}

async function waitForProjectStateRetry(
  queue: ProjectStateReportQueue,
  delayMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (queue.wakeRetry === done) queue.wakeRetry = undefined;
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    timer.unref();
    queue.wakeRetry = done;
  });
}

async function drainProjectStateReports(
  project_id: string,
  queue: ProjectStateReportQueue,
): Promise<void> {
  let retry = 0;
  let current: HostProjectStatus["state"] | undefined;
  while (queue.pending || current) {
    if (queue.pending) {
      current = queue.pending;
      queue.pending = undefined;
      retry = 0;
    }
    if (!current) break;
    queue.activeKey = projectStateReportKey(current);
    try {
      await sendProjectStateToMaster(project_id, current);
      current = undefined;
      retry = 0;
    } catch (err) {
      logger.debug("reportProjectStateToMaster failed", {
        project_id,
        state: current,
        retry,
        err,
      });
      if (queue.pending) continue;
      if (retry >= PROJECT_STATE_RETRY_DELAYS_MS.length) break;
      await waitForProjectStateRetry(
        queue,
        PROJECT_STATE_RETRY_DELAYS_MS[retry++],
      );
    } finally {
      queue.activeKey = undefined;
    }
  }
}

async function sendProjectStateToMaster(
  project_id: string,
  state: HostProjectStatus["state"],
): Promise<void> {
  if (!statusClient || !hostInfo) {
    throw new Error("master status client is not connected");
  }
  const request = {
    ...hostInfo,
    project_id,
    state,
  };
  const started = Date.now();
  logger.debug("reportProjectStateToMaster", { project_id, state });
  try {
    const res = await statusClient.reportProjectState(request);
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportProjectState",
      args: [request],
      result: res,
      duration_ms: Date.now() - started,
    });
    if ((res as any)?.action === "delete") {
      logger.debug("master requested local project deletion", { project_id });
      queueProjectDataDeletion(project_id);
      return;
    }
    // A newer local state may have been written while this RPC was in flight.
    // Only acknowledge the exact state the master accepted so the newer state
    // remains queued for the background reporter.
    const reportedState = typeof state === "string" ? state : state.state;
    if (reportedState) {
      markProjectStateReported(
        project_id,
        reportedState,
        typeof state === "string" ? undefined : state.runtime_exit_reason,
      );
    }
  } catch (err) {
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportProjectState",
      args: [request],
      error: true,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

setProjectStateReporter(reportProjectStateToMaster);

export function queueProvisionedInventory(project_ids: string[]) {
  const checked_at = Date.now();
  pendingInventory = { project_ids, checked_at };
  reportProvisionedInventory().catch((err) =>
    logger.debug("reportProvisionedInventory failed", { err }),
  );
}

export function startProvisionedInventoryReporter({
  bootstrapProjectIds,
  verifyBatch,
  intervalMs = provisionedInventoryIntervalMs(),
}: {
  bootstrapProjectIds: () =>
    | Promise<string[] | undefined>
    | string[]
    | undefined;
  verifyBatch?: () => Promise<unknown> | unknown;
  intervalMs?: number;
}): () => void {
  let closed = false;
  let running = false;
  const bootstrap = async () => {
    if (closed || running) return;
    running = true;
    try {
      const listed = await bootstrapProjectIds();
      if (listed == null) return;
      const project_ids = Array.from(
        new Set(
          listed
            .map((project_id) => `${project_id ?? ""}`.trim())
            .filter(Boolean),
        ),
      );
      queueProvisionedInventory(project_ids);
    } catch (err) {
      logger.warn("provisioned inventory bootstrap skipped", {
        err: `${err}`,
      });
    } finally {
      running = false;
    }
  };
  void bootstrap();
  const timer =
    verifyBatch == null
      ? undefined
      : setInterval(() => {
          if (closed || running) return;
          running = true;
          Promise.resolve(verifyBatch())
            .catch((err) =>
              logger.warn("bounded provisioned inventory audit failed", {
                err: `${err}`,
              }),
            )
            .finally(() => {
              running = false;
            });
        }, intervalMs);
  timer?.unref();
  return () => {
    closed = true;
    if (timer) clearInterval(timer);
  };
}

export function resetMasterStatusForTests(): void {
  if (resendTimer) {
    clearInterval(resendTimer);
    resendTimer = undefined;
  }
  statusClient = undefined;
  hostInfo = undefined;
  masterClient = undefined;
  for (const queue of projectStateReportQueues.values()) {
    queue.wakeRetry?.();
  }
  projectStateReportQueues.clear();
  pendingInventory = null;
  pendingProjectDeletions.clear();
  projectDeletionWorkerRunning = false;
}

async function reportProvisionedInventory() {
  if (!statusClient || !hostInfo || !pendingInventory) return;
  const payload = pendingInventory;
  const request = {
    ...hostInfo,
    project_ids: payload.project_ids,
    checked_at: payload.checked_at,
  };
  const started = Date.now();
  try {
    logger.debug("reportHostProvisionedInventory", {
      count: payload.project_ids.length,
    });
    const res = await statusClient.reportHostProvisionedInventory(request);
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportHostProvisionedInventory",
      args: [request],
      result: res,
      duration_ms: Date.now() - started,
      stats: {
        project_ids: payload.project_ids.length,
        delete_project_ids: (res as any)?.delete_project_ids?.length ?? 0,
      },
    });
    const deleteIds = (res as any)?.delete_project_ids ?? [];
    if (Array.isArray(deleteIds) && deleteIds.length) {
      logger.info("queueing stale project data deletion", {
        count: deleteIds.length,
      });
      for (const project_id of deleteIds) {
        queueProjectDataDeletion(project_id);
      }
    }
    pendingInventory = null;
  } catch (err) {
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportHostProvisionedInventory",
      args: [request],
      error: true,
      duration_ms: Date.now() - started,
      stats: { project_ids: payload.project_ids.length },
    });
    logger.debug("reportHostProvisionedInventory failed", { err });
  }
}

export function queueProjectProvisioned(
  project_id: string,
  provisioned: boolean,
) {
  const changed = setProjectProvisioned(project_id, provisioned);
  if (!changed) return;
  reportProjectProvisionedToMaster(project_id, provisioned).catch((err) =>
    logger.debug("reportProjectProvisionedToMaster failed", {
      project_id,
      provisioned,
      err,
    }),
  );
}

async function reportProjectProvisionedToMaster(
  project_id: string,
  provisioned: boolean,
) {
  if (!statusClient || !hostInfo) return;
  const request = {
    ...hostInfo,
    project_id,
    provisioned,
  };
  const started = Date.now();
  try {
    logger.debug("reportProjectProvisionedToMaster", {
      project_id,
      provisioned,
    });
    const res = await statusClient.reportProjectProvisioned(request);
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportProjectProvisioned",
      args: [request],
      result: res,
      duration_ms: Date.now() - started,
    });
    if ((res as any)?.action === "delete") {
      logger.debug("master requested local project deletion", { project_id });
      queueProjectDataDeletion(project_id);
      return;
    }
    markProjectProvisionedReported(project_id);
  } catch (err) {
    recordProjectHostRpcTraffic({
      channel: "status",
      method: "reportProjectProvisioned",
      args: [request],
      error: true,
      duration_ms: Date.now() - started,
    });
    logger.debug("reportProjectProvisionedToMaster failed", {
      project_id,
      provisioned,
      err,
    });
  }
}

async function reportPendingStates() {
  if (!statusClient || !hostInfo) return;
  const pending = listUnreportedProjects();
  for (const row of pending) {
    if (!row.state) continue;
    await reportProjectStateToMaster(row.project_id, {
      state: row.state as any,
      time: new Date(row.state_updated_at ?? row.updated_at ?? Date.now()),
      ...(row.runtime_exit_reason
        ? { runtime_exit_reason: row.runtime_exit_reason as any }
        : {}),
    });
  }
  await reportPendingProvisioning();
  await reportPendingProjectTouches();
  await syncAccountRevocationsFromMaster();
}

async function reportPendingProvisioning() {
  if (!statusClient || !hostInfo) return;
  const pending = listUnreportedProvisioning();
  for (const row of pending) {
    await reportProjectProvisionedToMaster(row.project_id, row.provisioned);
  }
  await reportProvisionedInventory();
}

async function syncAccountRevocationsFromMaster() {
  if (!statusClient || !hostInfo) return;
  let cursor = getRevocationSyncCursor() ?? { updated_ms: 0, account_id: "" };
  // Bound loop so one invocation cannot run forever.
  for (let i = 0; i < 20; i++) {
    let response:
      | {
          rows?: Array<{
            account_id: string;
            revoked_before_ms: number;
            updated_ms: number;
          }>;
          next_cursor_updated_ms?: number;
          next_cursor_account_id?: string;
        }
      | undefined;
    const request = {
      host_id: hostInfo.host_id,
      cursor_updated_ms: cursor.updated_ms,
      cursor_account_id: cursor.account_id,
      limit: 500,
    };
    const started = Date.now();
    try {
      response = await statusClient.syncAccountRevocations(request);
      recordProjectHostRpcTraffic({
        channel: "status",
        method: "syncAccountRevocations",
        args: [request],
        result: response,
        duration_ms: Date.now() - started,
        stats: {
          rows: response?.rows?.length ?? 0,
        },
      });
    } catch (err) {
      recordProjectHostRpcTraffic({
        channel: "status",
        method: "syncAccountRevocations",
        args: [request],
        error: true,
        duration_ms: Date.now() - started,
      });
      logger.debug("syncAccountRevocationsFromMaster failed", { err });
      return;
    }
    const rows = response?.rows ?? [];
    if (!rows.length) {
      return;
    }
    for (const row of rows) {
      upsertAccountRevocation({
        account_id: row.account_id,
        revoked_before_ms: row.revoked_before_ms,
        updated_ms: row.updated_ms,
      });
    }
    const nextUpdatedMs = Number(response?.next_cursor_updated_ms);
    const nextAccountId = `${response?.next_cursor_account_id ?? ""}`;
    if (!Number.isFinite(nextUpdatedMs) || nextUpdatedMs < 0) {
      return;
    }
    cursor = {
      updated_ms: Math.floor(nextUpdatedMs),
      account_id: nextAccountId,
    };
    setRevocationSyncCursor(cursor);
    if (rows.length < 500) {
      return;
    }
  }
}
