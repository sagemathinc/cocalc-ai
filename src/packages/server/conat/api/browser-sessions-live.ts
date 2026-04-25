/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import type { BrowserSessionLiveInfo } from "./browser-sessions";

const logger = getLogger("server:conat:api:browser-sessions-live");

function getActivityTs(stat: ConnectionStats | undefined): number {
  return Math.max(stat?.active ?? 0, stat?.connected ?? 0);
}

export async function getLiveBrowserSessionInfo(
  account_id: string,
): Promise<Map<string, BrowserSessionLiveInfo> | undefined> {
  const out = new Map<string, BrowserSessionLiveInfo>();
  try {
    const client = conat();
    await client.waitUntilSignedIn({ timeout: 3_000 });
    const statsByNode = await sysApiMany(client, { maxWait: 2_000 }).stats();
    for await (const node of statsByNode ?? []) {
      for (const sockets of Object.values(node ?? {})) {
        for (const stat of Object.values(sockets ?? {})) {
          const s = stat as ConnectionStats | undefined;
          if (!s?.user || s.user.account_id !== account_id) continue;
          const browser_id = `${s.browser_id ?? ""}`.trim();
          if (!browser_id) continue;
          const prev = out.get(browser_id);
          const nextCount = (prev?.connection_count ?? 0) + 1;
          const nextActive = Math.max(
            prev?.updated_at_ms ?? 0,
            getActivityTs(s),
          );
          out.set(browser_id, {
            connected: true,
            connection_count: nextCount,
            ...(nextActive > 0 ? { updated_at_ms: nextActive } : {}),
          });
        }
      }
    }
    return out;
  } catch (err) {
    logger.debug("failed to read live browser session conat stats", `${err}`);
    return undefined;
  }
}

export async function listLiveBrowserSessionAccountIds({
  max_age_ms,
}: {
  max_age_ms?: number;
} = {}): Promise<string[] | undefined> {
  const out = new Set<string>();
  const cleanMaxAgeMs =
    Number.isFinite(Number(max_age_ms)) && Number(max_age_ms) > 0
      ? Math.floor(Number(max_age_ms))
      : undefined;
  const cutoff =
    cleanMaxAgeMs == null
      ? Number.NEGATIVE_INFINITY
      : Date.now() - cleanMaxAgeMs;
  try {
    const client = conat();
    await client.waitUntilSignedIn({ timeout: 3_000 });
    const statsByNode = await sysApiMany(client, { maxWait: 2_000 }).stats();
    for await (const node of statsByNode ?? []) {
      for (const sockets of Object.values(node ?? {})) {
        for (const stat of Object.values(sockets ?? {})) {
          const s = stat as ConnectionStats | undefined;
          const account_id = `${s?.user?.account_id ?? ""}`.trim();
          const browser_id = `${s?.browser_id ?? ""}`.trim();
          if (!account_id || !browser_id) continue;
          if (getActivityTs(s) < cutoff) continue;
          out.add(account_id);
        }
      }
    }
    return [...out];
  } catch (err) {
    logger.debug(
      "failed to read live browser session account ids from conat stats",
      `${err}`,
    );
    return undefined;
  }
}
