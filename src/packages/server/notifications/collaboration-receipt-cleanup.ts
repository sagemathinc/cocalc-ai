/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { randomUUID } from "node:crypto";
import { collaborationMaintenanceAccountGuards } from "@cocalc/database/postgres/collaborators/collaborators-account-maintenance";
import type { CollaborationNotificationReceiptQuery } from "@cocalc/util/collaboration-attention";

/** Prune only after exact owner settlement or authoritative hard deletion.
 * Claiming and preparing the home fence atomically invalidates prior deliveries.
 * Rechecking it after RPC closes the delayed-authorize/delete/replay race.
 * Unavailable owners retain receipts. A durable retry date keeps them from
 * monopolizing the bounded pass. Neither summary flush nor age proves settlement.
 */
export async function pruneCollaborationSummaryReceipts(
  bay_id: string,
  pending: (input: CollaborationNotificationReceiptQuery) => Promise<string[]>,
) {
  const guards = await collaborationMaintenanceAccountGuards(getPool());
  const candidates = (
    await getPool().query(
      `SELECT r.account_id,r.project_id FROM collaboration_notification_summary_receipts r
     JOIN accounts a USING(account_id) WHERE a.home_bay_id=$1 AND r.cleanup_after<=clock_timestamp()
     AND ${guards.join(" AND ") || "TRUE"}
     GROUP BY r.account_id,r.project_id ORDER BY min(r.cleanup_after),r.account_id,r.project_id LIMIT 8`,
      [bay_id],
    )
  ).rows;
  let removed = 0;
  // Groups for a single account/project are unique; different projects have
  // independent authorization fences. Bound remote work to eight owner calls.
  await Promise.all(
    candidates.map(async ({ account_id, project_id }) => {
      let claim_id: string | undefined;
      try {
        const claim = await withAccountRehomeWriteFence({
          account_id,
          action: "claim notification receipt cleanup",
          fn: async (db) => {
            // Claim the account/project before superseding authorization. A
            // losing replica, including one that saw the same due candidates,
            // must not invalidate the winner's proof. The lease also covers
            // other due pages of the same project while this RPC is in flight.
            const rows = (
              await db.query(
                `SELECT event_id,obligation_id FROM collaboration_notification_summary_receipts
               WHERE account_id=$1 AND project_id=$2 AND cleanup_after<=clock_timestamp()
               ORDER BY cleanup_after,event_id LIMIT 100`,
                [account_id, project_id],
              )
            ).rows;
            if (!rows.length) return null;
            await db.query(
              `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
               VALUES($1,$2,'infinity','infinity') ON CONFLICT DO NOTHING`,
              [account_id, project_id],
            );
            const token = randomUUID();
            const lease = (
              await db.query(
                `UPDATE collaboration_access SET notification_cleanup_claim=$3,
               notification_cleanup_until=clock_timestamp()+interval '60 seconds',grant_request_id=$3
               WHERE account_id=$1 AND project_id=$2 AND
                 (notification_cleanup_until IS NULL OR notification_cleanup_until<=clock_timestamp())
               RETURNING notification_cleanup_until AS expires_at`,
                [account_id, project_id, token],
              )
            ).rows[0];
            if (!lease) return null;
            await db.query(
              `UPDATE collaboration_notification_summary_receipts SET cleanup_after=clock_timestamp()+interval '5 minutes'
               WHERE account_id=$1 AND event_id=ANY($2::uuid[])`,
              [account_id, rows.map((r) => r.event_id)],
            );
            return {
              rows,
              request_id: token,
              expires_at: lease.expires_at.toISOString(),
            };
          },
        });
        if (!claim) return;
        const { rows, ...fence } = claim;
        claim_id = fence.request_id;
        const ids = rows.map((r) => r.obligation_id);
        const retained = await pending({
          account_id,
          project_id,
          obligation_ids: ids,
        });
        if (
          !Array.isArray(retained) ||
          retained.some((id) => !ids.includes(id))
        )
          throw Error("invalid notification settlement proof");
        const count = await withAccountRehomeWriteFence({
          account_id,
          action: "prune settled notification receipts",
          fn: async (db) => {
            const current = await db.query(
              `SELECT 1 FROM collaboration_access WHERE account_id=$1 AND project_id=$2
           AND grant_request_id=$3 AND notification_cleanup_claim=$3
           AND clock_timestamp()<$4::timestamptz FOR UPDATE`,
              [account_id, project_id, fence.request_id, fence.expires_at],
            );
            if (!current.rows.length) return 0;
            return (
              await db.query(
                `DELETE FROM collaboration_notification_summary_receipts WHERE account_id=$1
           AND project_id=$2 AND event_id=ANY($3::uuid[]) AND NOT(obligation_id=ANY($4::uuid[])) RETURNING event_id`,
                [account_id, project_id, rows.map((r) => r.event_id), retained],
              )
            ).rows.length;
          },
        });
        removed += count;
      } catch {
        // Unknown owner/home outcomes retain exact deduplication evidence.
      } finally {
        if (claim_id) {
          try {
            await withAccountRehomeWriteFence({
              account_id,
              action: "release notification cleanup claim",
              fn: async (db) => {
                await db.query(
                  `UPDATE collaboration_access SET notification_cleanup_claim=NULL,notification_cleanup_until=NULL
                 WHERE account_id=$1 AND project_id=$2 AND notification_cleanup_claim=$3`,
                  [account_id, project_id, claim_id],
                );
              },
            });
          } catch {
            // A crashed/moved home leaves a bounded lease, never a permanent lock.
          }
        }
      }
    }),
  );
  return removed;
}
