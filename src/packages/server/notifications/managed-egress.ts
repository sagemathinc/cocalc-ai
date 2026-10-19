/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account notice when a managed-egress pool reaches 90% of a window's limit,
// or blocks.  Egress blocks must never be silent: the banner only shows in a
// browser that can connect, so this notice is the durable record (and email,
// per the account's notification preferences).

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import { humanSize } from "@cocalc/util/misc";
import LRU from "lru-cache";

const logger = getLogger("notifications:managed-egress");

export const MANAGED_EGRESS_NOTICE_THRESHOLD = 0.9;
const NOTICE_DEDUPE_HOURS = 24;
// Admission checks run every 30 s per account and category; check the
// database for a given notice at most this often per process.
const LOCAL_RECHECK_MS = 10 * 60_000;
const recentlyChecked = new LRU<string, true>({
  max: 50_000,
  ttl: LOCAL_RECHECK_MS,
});

export type ManagedEgressPool = "control-plane" | "shared";

export interface ManagedEgressNoticeInput {
  account_id: string;
  pool: ManagedEgressPool;
  window: "5h" | "7d";
  used: number;
  limit: number;
  blocked: boolean;
  resets_at?: Date;
}

// A notice is due when blocked (whatever the limit, including 0), or at 90%
// of a positive limit.
export function managedEgressNoticeDue(
  input: Pick<ManagedEgressNoticeInput, "used" | "limit" | "blocked">,
): boolean {
  if (!Number.isFinite(input.limit) || input.limit < 0) return false;
  if (input.blocked) return true;
  return (
    input.limit > 0 &&
    input.used >= MANAGED_EGRESS_NOTICE_THRESHOLD * input.limit
  );
}

function poolLabel(pool: ManagedEgressPool): string {
  return pool === "control-plane"
    ? "Browser control traffic"
    : "Managed network traffic";
}

export function managedEgressNoticeSummary(input: ManagedEgressNoticeInput) {
  // a 0 limit has no meaningful percentage
  const percent =
    input.limit > 0 ? Math.floor((100 * input.used) / input.limit) : undefined;
  const label = poolLabel(input.pool);
  const amounts =
    percent == null
      ? `${humanSize(input.used)} with a limit of 0 (no traffic allowed)`
      : `${humanSize(input.used)} of ${humanSize(input.limit)} (${percent}%)`;
  const usage = `${amounts} in the last ${input.window === "5h" ? "5 hours" : "7 days"}`;
  const reset =
    input.resets_at && Number.isFinite(input.resets_at.getTime())
      ? ` It is expected to be back under the limit by ${input.resets_at.toISOString()}.`
      : "";
  const effect =
    input.pool === "control-plane"
      ? input.blocked
        ? "New browser sessions for this account are blocked. The command line (cocalc CLI) still works."
        : "Over the limit, new browser sessions for this account are blocked. The command line (cocalc CLI) is not affected."
      : input.blocked
        ? "Until usage is back under the limit, downloads, app traffic, interactive sessions, SSH and backups are blocked, and running projects that send outbound network traffic are stopped."
        : "Over the limit, downloads, app traffic, interactive sessions, SSH, backups and outbound project network traffic may be blocked.";
  const todo =
    input.pool === "control-plane"
      ? "If you need a higher limit, contact support."
      : "Upgrade your membership for higher limits, or contact support.";
  return {
    title: input.blocked
      ? `${label} limit reached`
      : `${label} is at ${percent ?? 100}% of its limit`,
    severity: input.blocked ? "error" : "warning",
    origin_label: "Network usage",
    notice_type: input.blocked
      ? "managed_egress_blocked"
      : "managed_egress_near_limit",
    body_markdown: `${label}: ${usage}.${reset} ${effect} ${todo}`,
    action_label: "Open membership details",
    action_link: "/settings/membership",
  };
}

// Returns true if a notice was created.  At most one notice per pool, window
// and level (near/blocked) per account per day.
export async function notifyManagedEgressLimit(
  input: ManagedEgressNoticeInput,
): Promise<boolean> {
  if (!managedEgressNoticeDue(input)) return false;
  const { account_id } = input;
  const level = input.blocked ? "blocked" : "near";
  const key = `managed-egress:${input.pool}:${input.window}:${level}:${account_id}`;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locks } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      [key],
    );
    if (!locks[0]?.locked) {
      await client.query("COMMIT");
      return false;
    }
    const bay = getConfiguredBayId();
    // Notices are created by the account's home bay.
    const { rows: accounts } = await client.query(
      `SELECT 1 FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE
       AND COALESCE(NULLIF(home_bay_id,''),$3)=$2 FOR SHARE`,
      [account_id, bay, DEFAULT_BAY_ID],
    );
    if (accounts.length === 0) {
      await client.query("COMMIT");
      return false;
    }
    const { rows: existing } = await client.query(
      `SELECT 1 FROM notification_targets WHERE target_account_id=$1 AND dedupe_key=$2
       AND created_at > NOW() - make_interval(hours => $3) LIMIT 1`,
      [account_id, key, NOTICE_DEDUPE_HOURS],
    );
    if (existing.length) {
      await client.query("COMMIT");
      return false;
    }
    const summary = managedEgressNoticeSummary(input);
    await createNotificationEventGraphInTransaction({
      db: client,
      input: {
        kind: "account_notice",
        source_bay_id: bay,
        origin_kind: "system",
        payload_json: summary,
        targets: [
          {
            target_account_id: account_id,
            target_home_bay_id: bay,
            dedupe_key: key,
            summary_json: summary,
          },
        ],
      },
    });
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Fire-and-forget from admission checks: never delays or fails the check.
export function maybeNotifyManagedEgressLimit(
  input: ManagedEgressNoticeInput,
): void {
  if (!managedEgressNoticeDue(input)) return;
  const level = input.blocked ? "blocked" : "near";
  const localKey = `${input.pool}:${input.window}:${level}:${input.account_id}`;
  if (recentlyChecked.has(localKey)) return;
  recentlyChecked.set(localKey, true);
  notifyManagedEgressLimit(input).catch((err) => {
    recentlyChecked.delete(localKey);
    logger.warn("managed egress notice deferred", {
      account_id: input.account_id,
      pool: input.pool,
      window: input.window,
      err: `${err}`,
    });
  });
}

export const __test__ = {
  clearRecentlyChecked: () => recentlyChecked.clear(),
};
