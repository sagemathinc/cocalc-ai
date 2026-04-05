/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import {
  ACCOUNT_FEED_STREAM_CONFIG,
  accountFeedStreamName,
  type AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";

const logger = getLogger("server:account:feed");

export async function publishAccountFeedEvent(opts: {
  account_id: string;
  event: AccountFeedEvent;
}): Promise<void> {
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const stream = conat().sync.astream<AccountFeedEvent>({
    account_id,
    name: accountFeedStreamName(),
    ephemeral: true,
    config: ACCOUNT_FEED_STREAM_CONFIG,
  });
  await stream.publish({
    ...opts.event,
    account_id,
  });
}

export async function publishAccountFeedEventBestEffort(opts: {
  account_id: string;
  event: AccountFeedEvent;
}): Promise<void> {
  try {
    await publishAccountFeedEvent(opts);
  } catch (err) {
    logger.warn("failed to publish account feed event", {
      account_id: opts.account_id,
      type: opts.event.type,
      err: `${err}`,
    });
  }
}
