/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import getLogger from "@cocalc/backend/logger";
import { MAX_ACCOUNT_SUMMARY_RECEIPTS } from "@cocalc/util/collaboration-notification-limits";
import { collaborationMaintenanceAccountGuards } from "@cocalc/database/postgres/collaborators/collaborators-account-maintenance";

const logger = getLogger("notifications:collaboration-summary");
export const NOTIFICATION_WINDOW_MS = 60_000;
export const RECIPIENT_ALERTS_PER_WINDOW = 10;
export const ACTOR_ALERTS_PER_WINDOW = 3;
export { MAX_ACCOUNT_SUMMARY_RECEIPTS };

/** Runs after authority, attention and individual graph replay checks, under the
 * account-home fence in the graph transaction. Overflow is one bounded counter
 * per recipient, not an unbounded list of messages. Receipts preserve exact replay
 * identity even after its summary was delivered or the account moved homes.
 * At the receipt cap, retain owner work until confirmed-settlement cleanup.
 */
export async function admitCollaborationAlert({
  db,
  account_id,
  actor_account_id,
  event_id,
  event_hash,
  project_id,
  obligation_id,
}: {
  db: PoolClient;
  account_id: string;
  actor_account_id: string;
  event_id: string;
  event_hash: string;
  project_id: string;
  obligation_id?: string;
}): Promise<{
  status: "created" | "duplicate";
  notification_id: string;
} | null> {
  const receipt = (
    await db.query(
      "SELECT event_hash,notification_id FROM collaboration_notification_summary_receipts WHERE account_id=$1 AND event_id=$2",
      [account_id, event_id],
    )
  ).rows[0];
  if (receipt) {
    if (receipt.event_hash !== event_hash)
      throw Error("conflicting collaboration summary identity");
    return { status: "duplicate", notification_id: receipt.notification_id };
  }
  const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const budget = (
    await db.query(
      "SELECT * FROM collaboration_notification_delivery_budget WHERE account_id=$1 FOR UPDATE",
      [account_id],
    )
  ).rows[0];
  const fresh =
    !budget ||
    now.getTime() - budget.window_start.getTime() >= NOTIFICATION_WINDOW_MS;
  const delivered = fresh ? 0 : Number(budget.delivered);
  // At most ten accepted actors enter this map per window. Overflow never adds keys.
  const actors: Record<string, number> = fresh ? {} : budget.actors;
  const count = actors[actor_account_id] ?? 0;
  if (
    delivered < RECIPIENT_ALERTS_PER_WINDOW &&
    count < ACTOR_ALERTS_PER_WINDOW
  ) {
    actors[actor_account_id] = count + 1;
    await db.query(
      `INSERT INTO collaboration_notification_delivery_budget(account_id,window_start,delivered,actors)
       VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(account_id) DO UPDATE SET
       window_start=excluded.window_start,delivered=excluded.delivered,actors=excluded.actors`,
      [
        account_id,
        fresh ? now : budget.window_start,
        delivered + 1,
        JSON.stringify(actors),
      ],
    );
    return null;
  }
  if (!obligation_id)
    throw Error("grouped notification requires owner obligation");
  const retained = (
    await db.query(
      "SELECT count(*) AS n FROM collaboration_notification_summary_receipts WHERE account_id=$1",
      [account_id],
    )
  ).rows[0];
  if (Number(retained.n) >= MAX_ACCOUNT_SUMMARY_RECEIPTS)
    throw Error(
      "notification receipt capacity reached; retry after settlement cleanup",
    );
  const summary = (
    await db.query(
      `INSERT INTO collaboration_notification_summary(account_id,summary_id,count,due_at)
     VALUES($1,$2,1,$3) ON CONFLICT(account_id) DO UPDATE SET count=collaboration_notification_summary.count+1
     RETURNING summary_id`,
      [
        account_id,
        randomUUID(),
        new Date(now.getTime() + NOTIFICATION_WINDOW_MS),
      ],
    )
  ).rows[0];
  const notification_id = uuidv5("notification", summary.summary_id);
  await db.query(
    `INSERT INTO collaboration_notification_summary_receipts(account_id,event_id,event_hash,notification_id,project_id,obligation_id)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      account_id,
      event_id,
      event_hash,
      notification_id,
      project_id,
      obligation_id,
    ],
  );
  return { status: "created", notification_id };
}

/** Pending summaries are account-owned delivery obligations, independent of view
 * demand. Commit their graph and consume the counter together: a crash or lost
 * acknowledgment can neither lose the summary nor emit it twice. No content,
 * project titles or private locators are carried into this cross-project summary.
 */
export async function flushCollaborationSummaries(bay_id: string) {
  const guards = await collaborationMaintenanceAccountGuards(getPool());
  const candidates = (
    await getPool().query(
      `SELECT s.account_id FROM collaboration_notification_summary s JOIN accounts a USING(account_id)
     WHERE a.home_bay_id=$1 AND s.due_at<=clock_timestamp() AND ${guards.join(" AND ") || "TRUE"}
     ORDER BY s.due_at,s.account_id LIMIT 8`,
      [bay_id],
    )
  ).rows;
  let flushed = 0;
  for (const { account_id } of candidates) {
    try {
      const done = await withAccountRehomeWriteFence({
        account_id,
        action: "deliver collaboration summary",
        fn: async (db) => {
          const account = (
            await db.query(
              "SELECT home_bay_id FROM accounts WHERE account_id=$1",
              [account_id],
            )
          ).rows[0];
          if (account?.home_bay_id !== bay_id) return false;
          const summary = (
            await db.query(
              "SELECT * FROM collaboration_notification_summary WHERE account_id=$1 AND due_at<=clock_timestamp() FOR UPDATE",
              [account_id],
            )
          ).rows[0];
          if (!summary) return false;
          const key = JSON.stringify([
            "collaboration-message-v1",
            "summary",
            account_id,
            summary.summary_id,
          ]);
          const notification_id = uuidv5("notification", summary.summary_id);
          const payload = {
            notice_type: "collaboration_summary",
            title: "More activity in your conversations",
            body_markdown: `${summary.count} additional conversation notifications were grouped. [Open conversations](/people/conversations).`,
            origin_label: "People",
            priority: "normal",
            grouped_notifications: Number(summary.count),
          };
          await createNotificationEventGraphInTransaction({
            db,
            input: {
              event_id: summary.summary_id,
              kind: "account_notice",
              source_bay_id: bay_id,
              origin_kind: "account",
              payload_json: payload,
              targets: [
                {
                  target_account_id: account_id,
                  target_home_bay_id: bay_id,
                  notification_id,
                  dedupe_key: key,
                  summary_json: payload,
                },
              ],
            },
          });
          await db.query(
            "DELETE FROM collaboration_notification_summary WHERE account_id=$1 AND summary_id=$2",
            [account_id, summary.summary_id],
          );
          return true;
        },
      });
      if (done) flushed++;
    } catch {
      logger.warn(
        "notification summary delivery deferred; durable intent retained",
      );
    }
  }
  return flushed;
}
