import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { recordProjectHostRpcTraffic } from "./rpc-traffic-audit";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("project-host:last-edited");
const TOUCH_TTL_MS = 30_000;
const RUNNING_CHANGE_TTL_MS = 5 * 60_000;
const touchCache = new TTL<string, true>({ ttl: TOUCH_TTL_MS });
const runningChangeCache = new TTL<string, true>({
  ttl: RUNNING_CHANGE_TTL_MS,
});
const pendingProjectTouches = new Set<string>();
const pendingProjectTouchAccounts = new Map<string, Set<string>>();
const pendingProjectChanges = new Map<string, number | null>();
// Agent-turn activity (agent-turn-activity.ts): last_edited only, and
// whether to also queue the project's summary event.
const pendingActivityTouches = new Map<string, boolean>();
const runningGeneration = new Map<string, number>();
const projectChangeReportedListeners = new Set<(project_id: string) => void>();

export function onProjectChangeReported(
  listener: (project_id: string) => void,
): () => void {
  projectChangeReportedListeners.add(listener);
  return () => projectChangeReportedListeners.delete(listener);
}

export async function touchProjectLastEdited(
  project_id: string,
  _reason?: string,
  opts?: { account_id?: string; force?: boolean; flushNow?: boolean },
): Promise<void> {
  const cacheKey =
    opts?.account_id && isValidUUID(opts.account_id)
      ? `${project_id}:${opts.account_id}`
      : project_id;
  if (!opts?.force && touchCache.has(cacheKey)) {
    return;
  }
  touchCache.set(cacheKey, true);
  pendingProjectTouches.add(project_id);
  if (opts?.account_id && isValidUUID(opts.account_id)) {
    let accounts = pendingProjectTouchAccounts.get(project_id);
    if (accounts == null) {
      accounts = new Set<string>();
      pendingProjectTouchAccounts.set(project_id, accounts);
    }
    accounts.add(opts.account_id);
  }
  if (opts?.flushNow) {
    await reportPendingProjectTouches();
  }
}

/** A running agent turn: moves last_edited only (see hosts.touchProjectActivity). */
export function touchProjectActivity(
  project_id: string,
  opts: { summary?: boolean } = {},
): void {
  pendingActivityTouches.set(
    project_id,
    pendingActivityTouches.get(project_id) === true || opts.summary === true,
  );
}

export async function reportPendingProjectTouches(): Promise<void> {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    logger.debug("project touch flush skipped (missing client/host)", {
      pending: pendingProjectTouches.size,
      pendingChanges: pendingProjectChanges.size,
      pendingActivity: pendingActivityTouches.size,
    });
    return;
  }
  const touched = new Set<string>();
  for (const project_id of Array.from(pendingProjectTouches)) {
    const account_ids = Array.from(
      pendingProjectTouchAccounts.get(project_id) ?? [],
    );
    const request =
      account_ids.length === 0 ? { project_id } : { project_id, account_ids };
    const started = Date.now();
    try {
      await callHub({
        client,
        host_id,
        name: "hosts.touchProject",
        args: [request],
        timeout: 5000,
      });
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.touchProject",
        args: [request],
        duration_ms: Date.now() - started,
      });
      pendingProjectTouches.delete(project_id);
      pendingProjectTouchAccounts.delete(project_id);
      touched.add(project_id);
    } catch (err) {
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.touchProject",
        args: [request],
        error: true,
        duration_ms: Date.now() - started,
      });
      logger.debug("touchProjectLastEdited flush failed", {
        project_id,
        err: `${err}`,
      });
    }
  }
  for (const [project_id, summary] of Array.from(pendingActivityTouches)) {
    // A real touch for the project wins: it moves last_edited too and always
    // queues the summary event.
    if (touched.has(project_id) || pendingProjectTouches.has(project_id)) {
      pendingActivityTouches.delete(project_id);
      continue;
    }
    const request = { project_id, summary };
    const started = Date.now();
    try {
      await callHub({
        client,
        host_id,
        name: "hosts.touchProjectActivity",
        args: [request],
        timeout: 5000,
      });
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.touchProjectActivity",
        args: [request],
        duration_ms: Date.now() - started,
      });
      // Keep a summary that was requested while this one was in flight.
      if (pendingActivityTouches.get(project_id) === summary) {
        pendingActivityTouches.delete(project_id);
      }
    } catch (err) {
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.touchProjectActivity",
        args: [request],
        error: true,
        duration_ms: Date.now() - started,
      });
      logger.debug("touchProjectActivity flush failed", {
        project_id,
        err: `${err}`,
      });
    }
  }
  for (const [project_id, generation] of Array.from(pendingProjectChanges)) {
    const request =
      generation == null ? { project_id } : { project_id, generation };
    const started = Date.now();
    try {
      await callHub({
        client,
        host_id,
        name: "hosts.markProjectChanged",
        args: [request],
        timeout: 5000,
      });
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.markProjectChanged",
        args: [request],
        duration_ms: Date.now() - started,
      });
      pendingProjectChanges.delete(project_id);
      for (const listener of projectChangeReportedListeners) {
        try {
          listener(project_id);
        } catch (err) {
          logger.warn("project change listener failed", { project_id, err });
        }
      }
    } catch (err) {
      recordProjectHostRpcTraffic({
        channel: "hub-api",
        method: "hosts.markProjectChanged",
        args: [request],
        error: true,
        duration_ms: Date.now() - started,
      });
      logger.debug("markProjectChanged flush failed", {
        project_id,
        err: `${err}`,
      });
    }
  }
}

export function markProjectLastChanged(
  project_id: string,
  generation?: number | null,
): void {
  const normalizedGeneration =
    generation == null || !Number.isFinite(generation)
      ? null
      : Math.max(0, Math.floor(generation));
  const previous = pendingProjectChanges.get(project_id);
  if (
    previous == null ||
    (normalizedGeneration != null && normalizedGeneration > previous)
  ) {
    pendingProjectChanges.set(project_id, normalizedGeneration);
  }
}

export function markProjectLastChangedRunning(
  project_id: string,
  generation: number,
  opts?: { force?: boolean },
): void {
  if (!Number.isFinite(generation)) {
    return;
  }
  const normalizedGeneration = Math.max(0, Math.floor(generation));
  if (!opts?.force && runningChangeCache.has(project_id)) {
    return;
  }
  runningChangeCache.set(project_id, true);
  const previous = runningGeneration.get(project_id);
  runningGeneration.set(project_id, normalizedGeneration);
  if (previous != null && normalizedGeneration <= previous) {
    logger.debug("running generation unchanged", {
      project_id,
      generation: normalizedGeneration,
    });
    return;
  }
  logger.debug("running generation changed", {
    project_id,
    previous,
    generation: normalizedGeneration,
  });
  markProjectLastChanged(project_id, normalizedGeneration);
}

export function shouldCheckProjectLastChangedRunning(
  project_id: string,
): boolean {
  return !runningChangeCache.has(project_id);
}

export function resetProjectLastChangedRunning(project_id: string): void {
  runningChangeCache.delete(project_id);
  runningGeneration.delete(project_id);
}
