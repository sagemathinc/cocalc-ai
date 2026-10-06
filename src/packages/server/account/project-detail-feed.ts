/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";
import { listRecentBrowserSessionAccountIds } from "@cocalc/server/conat/api/browser-sessions";
import { listLiveBrowserSessionAccountIds } from "@cocalc/server/conat/api/browser-sessions-live";

const logger = getLogger("server:account:project-detail-feed");
const ACTIVE_BROWSER_MAX_AGE_MS = 3 * 60_000;
// The live lookup is a scatter-gather over every conat node that always waits
// out its full maxWait (2s), so share one lookup across a burst of changes. A
// browser that connected within this window may miss an invalidation, but it
// loads fresh project details when it connects anyway.
const LIVE_ACCOUNTS_CACHE_MS = 5_000;

let liveAccounts:
  | { started_at: number; ids: Promise<string[] | undefined> }
  | undefined;

function normalizeFields(fields: string[]): string[] {
  return [
    ...new Set(fields.map((field) => `${field ?? ""}`.trim()).filter(Boolean)),
  ];
}

function cachedLiveBrowserSessionAccountIds(): Promise<string[] | undefined> {
  const now = Date.now();
  if (
    liveAccounts == null ||
    now - liveAccounts.started_at > LIVE_ACCOUNTS_CACHE_MS
  ) {
    liveAccounts = {
      started_at: now,
      ids: listLiveBrowserSessionAccountIds({
        max_age_ms: ACTIVE_BROWSER_MAX_AGE_MS,
      }).catch(() => undefined),
    };
  }
  return liveAccounts.ids;
}

async function listActiveCollaboratorAccountIds(
  project_id: string,
): Promise<string[]> {
  const active = new Set(
    (await cachedLiveBrowserSessionAccountIds()) ??
      listRecentBrowserSessionAccountIds({
        max_age_ms: ACTIVE_BROWSER_MAX_AGE_MS,
      }),
  );
  if (active.size === 0) {
    return [];
  }
  const { rows } = await getPool().query<{ users?: Record<string, unknown> }>(
    "SELECT users FROM projects WHERE project_id = $1 AND deleted IS NOT true",
    [project_id],
  );
  const users = rows[0]?.users ?? {};
  return Object.keys(users).filter((account_id) => active.has(account_id));
}

// Invalidations only tell open browsers to refetch, so the change that caused
// one never waits for it: this returns at once and publishes in the background.
export async function publishProjectDetailInvalidationBestEffort(opts: {
  project_id: string;
  fields: string[];
}): Promise<void> {
  void publishProjectDetailInvalidation(opts).catch((err) =>
    logger.warn("failed to publish project detail invalidation", {
      project_id: opts?.project_id,
      err: `${err}`,
    }),
  );
}

export async function publishProjectDetailInvalidation(opts: {
  project_id: string;
  fields: string[];
}): Promise<void> {
  const project_id = `${opts.project_id ?? ""}`.trim();
  const fields = normalizeFields(opts.fields);
  if (!project_id || fields.length === 0) {
    return;
  }
  try {
    const account_ids = await listActiveCollaboratorAccountIds(project_id);
    if (account_ids.length === 0) {
      return;
    }
    const ts = Date.now();
    await Promise.all(
      account_ids.map((account_id) =>
        publishAccountFeedEventBestEffort({
          account_id,
          event: {
            type: "project.detail.invalidate",
            ts,
            account_id,
            project_id,
            fields,
          } satisfies AccountFeedEvent,
        }),
      ),
    );
  } catch (err) {
    logger.warn("failed to publish project detail invalidation", {
      project_id,
      fields,
      err: `${err}`,
    });
  }
}
