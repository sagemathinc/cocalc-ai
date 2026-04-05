/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import type {
  AccountFeedAccountRow,
  AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEventBestEffort } from "./feed";

function normalizeAccountPatch(
  patch: Record<string, any> | undefined,
): AccountFeedAccountRow {
  return { ...(patch ?? {}) };
}

export function enableDbAccountRowFeedPublishing() {
  db().publishAccountRowFeedEventsBestEffort =
    publishAccountRowFeedEventsBestEffort;
}

export async function publishAccountRowFeedEventsBestEffort(opts: {
  account_id: string;
  patch: Record<string, any>;
  reason?: "user_query_set" | "messages_unread_count_updated";
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    return;
  }
  const patch = normalizeAccountPatch(opts.patch);
  if (Object.keys(patch).length === 0) {
    return;
  }
  const event: AccountFeedEvent = {
    type: "account.upsert",
    ts: Date.now(),
    account_id,
    account: patch,
    reason: opts.reason ?? "user_query_set",
  };
  await publishAccountFeedEventBestEffort({
    account_id,
    event,
  });
}
