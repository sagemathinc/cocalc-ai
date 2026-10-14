/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { createNotificationEventGraph } from "@cocalc/database/postgres/notifications-core";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { v5 as uuidv5 } from "uuid";

// Event ids of project account notices are derived from their keys in this
// namespace, which makes delivery idempotent.
const NOTICE_EVENT_NAMESPACE = "56cde593-74c2-4a98-8cca-3b27e51b6d0e";

export type ProjectAccountNoticeSummary = {
  title: string;
  body_markdown: string;
  severity: "warning" | "info" | "error";
  notice_type: string;
  origin_label: string;
  action_link: string;
  action_label: string;
};

/**
 * Deliver one account notice about a project to one recipient, at most once
 * per eventKey (the event id is derived from it). Returns false if it was
 * already delivered.
 */
export async function deliverProjectAccountNotice({
  bayId,
  projectId,
  recipient,
  eventKey,
  dedupePrefix,
  summary,
}: {
  bayId: string;
  projectId: string;
  recipient: string;
  eventKey: string;
  dedupePrefix: string;
  summary: ProjectAccountNoticeSummary;
}): Promise<boolean> {
  const eventId = uuidv5(eventKey, NOTICE_EVENT_NAMESPACE);
  const existing = await getPool().query(
    "SELECT event_id FROM notification_events WHERE event_id=$1",
    [eventId],
  );
  if (existing.rows.length) return false;
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: recipient,
    user_account_id: recipient,
  });
  if (!home_bay_id) throw Error("recipient account home unavailable");
  try {
    await createNotificationEventGraph({
      event_id: eventId,
      kind: "account_notice",
      source_bay_id: bayId,
      source_project_id: projectId,
      origin_kind: "project",
      payload_json: summary,
      targets: [
        {
          target_account_id: recipient,
          target_home_bay_id: home_bay_id,
          dedupe_key: `${dedupePrefix}:${eventId}`,
          summary_json: summary,
        },
      ],
    });
    return true;
  } catch (err) {
    // A retiring primary worker can overlap its replacement. The event's
    // primary key makes this race harmless without dropping another failure.
    if ((err as { code?: string })?.code === "23505") {
      const { rows } = await getPool().query(
        "SELECT event_id FROM notification_events WHERE event_id=$1",
        [eventId],
      );
      if (rows.length) return false;
    }
    throw err;
  }
}
