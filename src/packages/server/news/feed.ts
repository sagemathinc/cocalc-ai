/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";
import { listRecentBrowserSessionAccountIds } from "@cocalc/server/conat/api/browser-sessions";

const logger = getLogger("server:news:feed");

function listActiveAccountIds(): string[] {
  return [
    ...new Set<string>(
      listRecentBrowserSessionAccountIds({
        max_age_ms: 3 * 60_000,
      }),
    ),
  ];
}

export async function publishNewsRefreshBestEffort(): Promise<void> {
  try {
    const ts = Date.now();
    const account_ids = listActiveAccountIds();
    await Promise.all(
      account_ids.map((account_id) =>
        publishAccountFeedEventBestEffort({
          account_id,
          event: {
            type: "news.refresh",
            ts,
            account_id,
          },
        }),
      ),
    );
  } catch (err) {
    logger.warn("failed to publish news refresh event", { err: `${err}` });
  }
}
