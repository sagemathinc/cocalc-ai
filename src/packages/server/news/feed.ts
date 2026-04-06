/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";

const logger = getLogger("server:news:feed");

async function listActiveAccountIds(): Promise<string[]> {
  const account_ids = new Set<string>();
  const client = conat();
  await client.waitUntilSignedIn({ timeout: 3_000 });
  const statsByNode = await sysApiMany(client, { timeout: 2_000 }).stats();
  for (const node of statsByNode ?? []) {
    for (const sockets of Object.values(node ?? {})) {
      for (const stat of Object.values(sockets ?? {})) {
        const connection = stat as ConnectionStats | undefined;
        const account_id = `${connection?.user?.account_id ?? ""}`.trim();
        if (!account_id) continue;
        if (connection?.user?.auth_actor === "agent") continue;
        account_ids.add(account_id);
      }
    }
  }
  return [...account_ids];
}

export async function publishNewsRefreshBestEffort(): Promise<void> {
  try {
    const ts = Date.now();
    const account_ids = await listActiveAccountIds();
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
