import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { recordProjectHostRpcTraffic } from "./rpc-traffic-audit";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("project-host:last-edited");
const TOUCH_TTL_MS = 30_000;
const RUNNING_TOUCH_TTL_MS = 5 * 60_000;
const touchCache = new TTL<string, true>({ ttl: TOUCH_TTL_MS });
const runningTouchCache = new TTL<string, true>({ ttl: RUNNING_TOUCH_TTL_MS });
const runningGeneration = new Map<string, number>();
const pendingProjectTouches = new Set<string>();
const pendingProjectTouchAccounts = new Map<string, Set<string>>();

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

export async function reportPendingProjectTouches(): Promise<void> {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    logger.debug("project touch flush skipped (missing client/host)", {
      pending: pendingProjectTouches.size,
    });
    return;
  }
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
}

export async function touchProjectLastEditedRunning(
  project_id: string,
  generation: number,
  reason = "running",
  opts?: { force?: boolean },
): Promise<void> {
  if (!Number.isFinite(generation)) {
    return;
  }
  if (!opts?.force && runningTouchCache.has(project_id)) {
    return;
  }
  runningTouchCache.set(project_id, true);
  const previous = runningGeneration.get(project_id);
  runningGeneration.set(project_id, generation);
  if (previous == null) {
    logger.debug("running generation baseline", { project_id, generation });
    return;
  }
  if (generation <= previous) {
    logger.debug("running generation unchanged", { project_id, generation });
    return;
  }
  logger.debug("running generation updated", {
    project_id,
    previous,
    generation,
    delta: generation - previous,
  });
  await touchProjectLastEdited(project_id, reason, { force: opts?.force });
}

export function shouldCheckProjectLastEditedRunning(
  project_id: string,
): boolean {
  return !runningTouchCache.has(project_id);
}

export function resetProjectLastEditedRunning(project_id: string): void {
  runningTouchCache.delete(project_id);
  runningGeneration.delete(project_id);
}
