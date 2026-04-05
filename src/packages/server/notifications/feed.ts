/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  type NotificationFeedEvent,
} from "@cocalc/conat/hub/api/notifications";
import { publishAccountFeedEvent } from "@cocalc/server/account/feed";

const logger = getLogger("server:notifications:feed");

export async function publishNotificationFeedInvalidate(opts: {
  account_id: string;
  reason: NotificationFeedEvent["reason"];
  notification_ids?: string[];
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await publishAccountFeedEvent({
    account_id,
    event: {
      type: "notification.invalidate",
      ts: Date.now(),
      account_id,
      reason: opts.reason,
      notification_ids: opts.notification_ids,
    },
  });
}

export async function publishNotificationFeedInvalidateBestEffort(opts: {
  account_id: string;
  reason: NotificationFeedEvent["reason"];
  notification_ids?: string[];
}): Promise<void> {
  try {
    await publishNotificationFeedInvalidate(opts);
  } catch (err) {
    logger.warn("failed to publish notification feed invalidate", {
      account_id: opts.account_id,
      reason: opts.reason,
      err: `${err}`,
    });
  }
}
