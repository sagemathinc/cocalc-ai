/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { AccountFeedEvent } from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";
import { listRecentBrowserSessionAccountIds } from "@cocalc/server/conat/api/browser-sessions";

const logger = getLogger("server:account:project-detail-feed");
const ACTIVE_BROWSER_MAX_AGE_MS = 3 * 60_000;

function normalizeFields(fields: string[]): string[] {
  return [
    ...new Set(fields.map((field) => `${field ?? ""}`.trim()).filter(Boolean)),
  ];
}

async function listActiveCollaboratorAccountIds(
  project_id: string,
): Promise<string[]> {
  const active = new Set(
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

export async function publishProjectDetailInvalidationBestEffort(opts: {
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
