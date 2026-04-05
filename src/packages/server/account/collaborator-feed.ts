/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import {
  refreshProjectedCollaboratorIdentityRows,
  type AccountCollaboratorIndexRowWithAccountId,
} from "@cocalc/database/postgres/account-collaborator-index";
import type {
  AccountFeedCollaboratorRow,
  AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { publishAccountFeedEventBestEffort } from "./feed";

function toFeedRow(
  row: AccountCollaboratorIndexRowWithAccountId,
): AccountFeedCollaboratorRow {
  return {
    account_id: row.collaborator_account_id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: row.name,
    last_active: row.last_active?.toISOString() ?? null,
    profile: row.profile ?? null,
    common_project_count: row.common_project_count,
    updated_at: row.updated_at?.toISOString() ?? null,
  };
}

export function enableDbCollaboratorAccountFeedPublishing() {
  db().publishCollaboratorAccountFeedEventsBestEffort =
    publishCollaboratorAccountFeedEventsBestEffort;
}

export async function publishCollaboratorAccountFeedEventsBestEffort(opts: {
  collaborator_account_id: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    const { updated_rows } = await refreshProjectedCollaboratorIdentityRows({
      db: client,
      collaborator_account_id: opts.collaborator_account_id,
    });
    const events: AccountFeedEvent[] = updated_rows.map((row) => ({
      type: "collaborator.upsert",
      ts: Date.now(),
      account_id: row.account_id,
      collaborator: toFeedRow(row),
    }));
    for (const event of events) {
      await publishAccountFeedEventBestEffort({
        account_id: event.account_id,
        event,
      });
    }
  } finally {
    client.release();
  }
}
