/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import {
  applyProjectEventToAccountCollaboratorIndex,
  loadLatestCollaboratorProjectionEvent,
} from "@cocalc/database/postgres/account-collaborator-index-projector";
import { computeAccountProjectFeedEvents } from "@cocalc/database/postgres/account-project-index-projector";
import {
  loadProjectOutboxPayload,
  type ProjectOutboxEventRow,
} from "@cocalc/database/postgres/project-events-outbox";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishAccountFeedEventBestEffort } from "./feed";

export function enableDbProjectAccountFeedPublishing() {
  db().publishProjectAccountFeedEventsBestEffort =
    publishProjectAccountFeedEventsBestEffort;
}

export async function publishProjectAccountFeedEventsBestEffort(opts: {
  project_id: string;
  default_bay_id?: string;
}): Promise<void> {
  const bay_id =
    `${opts.default_bay_id ?? getConfiguredBayId()}`.trim() || "bay-0";
  const client = await getPool().connect();
  try {
    const payload = await loadProjectOutboxPayload({
      db: client,
      project_id: opts.project_id,
      default_bay_id: bay_id,
    });
    const events = await computeAccountProjectFeedEvents({
      db: client,
      bay_id,
      payload,
    });
    for (const event of events) {
      await publishAccountFeedEventBestEffort({
        account_id: event.account_id,
        event,
      });
    }
    const latestRows = await client.query<
      Pick<ProjectOutboxEventRow, "event_id">
    >(
      `SELECT event_id
         FROM project_events_outbox
        WHERE project_id = $1
        ORDER BY created_at DESC, event_id DESC
        LIMIT 1`,
      [opts.project_id],
    );
    const collaboratorEvent = await loadLatestCollaboratorProjectionEvent({
      db: client,
      project_id: opts.project_id,
    });
    if (
      collaboratorEvent != null &&
      collaboratorEvent.event_id === latestRows.rows[0]?.event_id
    ) {
      const collaborator = await applyProjectEventToAccountCollaboratorIndex({
        db: client,
        bay_id,
        event: collaboratorEvent,
      });
      for (const event of collaborator.feed_events) {
        await publishAccountFeedEventBestEffort({
          account_id: event.account_id,
          event,
        });
      }
    }
  } finally {
    client.release();
  }
}
