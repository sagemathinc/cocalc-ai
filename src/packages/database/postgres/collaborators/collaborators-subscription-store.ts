/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import { hash } from "./collaborators-common";
import { MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS } from "@cocalc/util/collaboration-notification-limits";
export { MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS };

// Reserve at most 10k rows / about 3 MiB of the project handoff for routing hints.
// Both admission paths hold the project owner lock for count + insert.
export async function retainNotificationSubscriptions(
  db: PoolClient,
  project_id: string,
  hints: { entry_key: string; account_id: string }[],
) {
  if (!hints.length) return;
  project_id = project_id.toLowerCase();
  const canonical = [
    ...new Map(
      hints.map((hint) => {
        const account_id = hint.account_id.toLowerCase();
        const id = hash(
          JSON.stringify([project_id, hint.entry_key, account_id]),
        );
        return [id, { id, entry_key: hint.entry_key, account_id }];
      }),
    ).values(),
  ];
  await db.query(
    `INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id)
     SELECT s.id,$1,s.entry_key,s.account_id FROM jsonb_to_recordset($2::jsonb) AS s(id text,entry_key text,account_id uuid)
     JOIN projects p ON p.project_id=$1 WHERE p.users #>> ARRAY[s.account_id::text,'group'] IN ('owner','collaborator')
     ON CONFLICT(project_id,entry_key,account_id) DO NOTHING`,
    [project_id, JSON.stringify(canonical)],
  );
  const count = (
    await db.query(
      "SELECT count(*) AS n FROM collaboration_notification_subscriptions WHERE project_id=$1",
      [project_id],
    )
  ).rows[0];
  // Throwing rolls back the surrounding Follow/source transaction. Never accept
  // a follow choice whose routing intent cannot be retained and transferred.
  if (Number(count.n) > MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS)
    throw Error("project notification subscription limit exceeded");
}
