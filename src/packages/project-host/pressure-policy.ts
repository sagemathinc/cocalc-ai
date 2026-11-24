/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Whether this host's pressure monitor may act, as decided by the bay.

The bay answers from its own row for this host: a host in the shared pool is
protected as before; a private host (one account's own machine) is watch-only.
Its pressure monitor still measures and publishes the pressure zone, but
never stops a project, and project starts are not blocked by earlier pressure
cooldowns or quarantines.

States:
- known: the last reply that passed every check, kept in sqlite so a restart
  keeps it, refreshed every minute. A failed or malformed refresh keeps it.
- stale: a known policy whose evaluation is more than a day old. It keeps its
  value (a shared host stays protected at any age); it is only reported.
- unknown: no reply has ever been accepted (an empty store). The monitor then
  observes without acting until the bay answers, and reports policy_unknown.
*/

import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";
import {
  loadStoredPressurePolicy,
  saveStoredPressurePolicy,
  type StoredPressurePolicy,
} from "./sqlite/pressure-policy";

const logger = getLogger("project-host:pressure-policy");

export const PRESSURE_POLICY_REFRESH_MS = 60_000;
export const PRESSURE_POLICY_STALE_MS = 24 * 60 * 60_000;
export const PRESSURE_POLICY_MAX_FUTURE_MS = 5 * 60_000;

export type PressurePolicyToken =
  | "watch_only_private_host"
  | "policy_unknown"
  | "policy_stale";

export interface EffectivePressurePolicy {
  // true: measure and publish, but never stop a project or block a start
  watchOnly: boolean;
  // reason tokens to append to the published pressure reason
  tokens: PressurePolicyToken[];
  refreshFailures: number;
}

let current: StoredPressurePolicy | undefined;
let loaded = false;
let refreshFailures = 0;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    const hostId = getLocalHostId();
    // Until this host knows its own id, try again on the next call: a stored
    // policy can only be matched to an id.
    if (!hostId) return;
    loaded = true;
    const stored = loadStoredPressurePolicy();
    // a policy stored for another host id (a re-provisioned host) is not ours
    current = stored && stored.host_id === hostId ? stored : undefined;
  } catch (err) {
    loaded = true;
    logger.warn("unable to load the stored pressure policy", {
      err: `${err}`,
    });
    current = undefined;
  }
}

// A reply is accepted only when every field is exactly as the bay sends it
// for this host, and its evaluation time is recent and not in the future.
export function parsePressurePolicyReply(
  reply: unknown,
  hostId: string,
  now: number,
): StoredPressurePolicy | undefined {
  if (!hostId) return undefined;
  if (reply == null || typeof reply !== "object" || Array.isArray(reply)) {
    return undefined;
  }
  const r = reply as Record<string, unknown>;
  if (r.host_id !== hostId) return undefined;
  if (typeof r.watch_only !== "boolean") return undefined;
  const expectedReason = r.watch_only ? "private_host" : "shared_pool";
  if (r.reason !== expectedReason) return undefined;
  if (typeof r.evaluated_at !== "string") return undefined;
  const evaluatedAtMs = Date.parse(r.evaluated_at);
  if (!Number.isFinite(evaluatedAtMs)) return undefined;
  if (evaluatedAtMs < now - PRESSURE_POLICY_STALE_MS) return undefined;
  if (evaluatedAtMs > now + PRESSURE_POLICY_MAX_FUTURE_MS) return undefined;
  return {
    host_id: hostId,
    watch_only: r.watch_only,
    reason: expectedReason,
    evaluated_at_ms: evaluatedAtMs,
    fetched_at_ms: now,
  };
}

export function getEffectivePressurePolicy(
  now: number = Date.now(),
): EffectivePressurePolicy {
  ensureLoaded();
  if (!current) {
    return { watchOnly: true, tokens: ["policy_unknown"], refreshFailures };
  }
  const tokens: PressurePolicyToken[] = [];
  if (current.watch_only) tokens.push("watch_only_private_host");
  if (now - current.evaluated_at_ms > PRESSURE_POLICY_STALE_MS) {
    tokens.push("policy_stale");
  }
  return { watchOnly: current.watch_only, tokens, refreshFailures };
}

// One refresh. Returns true when a reply was accepted. A failed or malformed
// reply never changes the known policy.
export async function refreshPressurePolicy({
  fetchReply,
  hostId = getLocalHostId(),
  now = Date.now(),
}: {
  fetchReply: () => Promise<unknown>;
  hostId?: string;
  now?: number;
}): Promise<boolean> {
  ensureLoaded();
  let reply: unknown;
  try {
    reply = await fetchReply();
  } catch (err) {
    refreshFailures += 1;
    logger.debug("pressure policy refresh failed", { err: `${err}` });
    return false;
  }
  const parsed = parsePressurePolicyReply(reply, hostId ?? "", now);
  if (!parsed) {
    refreshFailures += 1;
    logger.warn("pressure policy reply refused; keeping the known policy");
    return false;
  }
  // The known policy changes only once the new one is stored, so the running
  // process and a restart always agree. A failed save is a failed refresh.
  try {
    saveStoredPressurePolicy(parsed);
  } catch (err) {
    refreshFailures += 1;
    logger.warn("unable to store the pressure policy; keeping the known policy", {
      err: `${err}`,
    });
    return false;
  }
  if (current?.watch_only !== parsed.watch_only) {
    logger.info("pressure policy", {
      watch_only: parsed.watch_only,
      reason: parsed.reason,
    });
  }
  current = parsed;
  return true;
}

let refreshStarted = false;

export function startPressurePolicyRefresh(): void {
  if (refreshStarted) return;
  refreshStarted = true;
  ensureLoaded();
  const fetchReply = async () => {
    const client = getMasterConatClient();
    const host_id = getLocalHostId();
    if (!client || !host_id) {
      throw new Error("master hub connection unavailable");
    }
    return await callHub({
      client,
      host_id,
      name: "hosts.getPressurePolicy",
      args: [{}],
      timeout: 30_000,
    });
  };
  const refresh = () => {
    void refreshPressurePolicy({ fetchReply });
  };
  refresh();
  const timer = setInterval(refresh, PRESSURE_POLICY_REFRESH_MS);
  timer.unref?.();
}

export const _test = {
  reset(): void {
    current = undefined;
    loaded = false;
    refreshFailures = 0;
    refreshStarted = false;
  },
};
