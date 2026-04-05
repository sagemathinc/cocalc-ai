/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  getProjectedNotificationCounts,
  listProjectedNotificationsByIdsForAccount,
  type AccountNotificationCounts,
  type AccountNotificationIndexRow,
} from "@cocalc/database/postgres/account-notification-index";
import {
  type AccountFeedNotificationCounts,
  type AccountFeedNotificationRow,
} from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEvent } from "@cocalc/server/account/feed";

const logger = getLogger("server:notifications:feed");

type NotificationReason =
  | "projected_upsert"
  | "read_state_updated"
  | "saved_state_updated"
  | "archived_state_updated";

function toFeedNotificationRow(
  row: AccountNotificationIndexRow,
): AccountFeedNotificationRow {
  return {
    notification_id: row.notification_id,
    kind: row.kind,
    project_id: row.project_id,
    summary: row.summary ?? {},
    read_state: row.read_state ?? {},
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
  };
}

function toFeedNotificationCounts(
  counts: AccountNotificationCounts,
): AccountFeedNotificationCounts {
  return {
    total: counts.total,
    unread: counts.unread,
    saved: counts.saved,
    archived: counts.archived,
    by_kind: counts.by_kind,
  };
}

async function publishNotificationFeedCounts(opts: {
  account_id: string;
  reason: NotificationReason;
  counts: AccountNotificationCounts;
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await publishAccountFeedEvent({
    account_id,
    event: {
      type: "notification.counts",
      ts: Date.now(),
      account_id,
      counts: toFeedNotificationCounts(opts.counts),
      reason: opts.reason,
    },
  });
}

async function publishNotificationFeedUpsert(opts: {
  account_id: string;
  reason: NotificationReason;
  row: AccountNotificationIndexRow;
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await publishAccountFeedEvent({
    account_id,
    event: {
      type: "notification.upsert",
      ts: Date.now(),
      account_id,
      notification: toFeedNotificationRow(opts.row),
      reason: opts.reason,
    },
  });
}

async function publishNotificationFeedRemove(opts: {
  account_id: string;
  reason: NotificationReason;
  notification_id: string;
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await publishAccountFeedEvent({
    account_id,
    event: {
      type: "notification.remove",
      ts: Date.now(),
      account_id,
      notification_id: opts.notification_id,
      reason: opts.reason,
    },
  });
}

export async function publishProjectedNotificationFeedUpdates(opts: {
  account_id: string;
  reason: NotificationReason;
  notification_ids: string[];
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const notification_ids = Array.from(
    new Set(
      (Array.isArray(opts.notification_ids) ? opts.notification_ids : []).filter(
        (notification_id) => `${notification_id ?? ""}`.trim() !== "",
      ),
    ),
  );
  const [rows, counts] = await Promise.all([
    listProjectedNotificationsByIdsForAccount({
      account_id,
      notification_ids,
    }),
    getProjectedNotificationCounts({ account_id }),
  ]);
  const rowById = new Map(rows.map((row) => [row.notification_id, row]));
  for (const notification_id of notification_ids) {
    const row = rowById.get(notification_id);
    if (row == null || row.read_state?.archived) {
      await publishNotificationFeedRemove({
        account_id,
        notification_id,
        reason: opts.reason,
      });
    } else {
      await publishNotificationFeedUpsert({
        account_id,
        row,
        reason: opts.reason,
      });
    }
  }
  await publishNotificationFeedCounts({
    account_id,
    counts,
    reason: opts.reason,
  });
}

export async function publishProjectedNotificationFeedUpdatesBestEffort(opts: {
  account_id: string;
  reason: NotificationReason;
  notification_ids: string[];
}): Promise<void> {
  try {
    await publishProjectedNotificationFeedUpdates(opts);
  } catch (err) {
    logger.warn("failed to publish notification feed updates", {
      account_id: opts.account_id,
      reason: opts.reason,
      notification_ids: opts.notification_ids,
      err: `${err}`,
    });
  }
}
