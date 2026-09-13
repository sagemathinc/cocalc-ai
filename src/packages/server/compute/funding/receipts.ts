/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { v5 as uuidv5 } from "uuid";
import type { PoolClient } from "@cocalc/database/pool";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";
import type { FundingBudget } from "@cocalc/util/compute-funding";
import { requireFundingAccountTransaction } from "./backing";
import type { CourseFundingPoolRow, CourseFundingGrantRow } from "./pools";

const RECEIPT_NAMESPACE = "3372e293-c160-4a58-b8cb-573de8174769";

/** Must run in the same transaction as the approved budget change. The existing
 * durable notification target outbox drives both home-bay inbox projections and
 * required critical billing email. Never make directory/network calls here:
 * resolve recipient homes before entering the funding transaction.
 */
export async function enqueueCourseFundingReceiptInTransaction(
  db: PoolClient,
  opts: {
    payer_account_id: string;
    operation_id: string;
    action: "allocated" | "revised" | "revoked" | "closing" | "closed";
    pool: CourseFundingPoolRow;
    grants: CourseFundingGrantRow[];
    home_bay_by_account_id: Record<string, string>;
  },
): Promise<void> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  const operation = fundingId(opts.operation_id, "Funding operation");
  requireFundingAccountTransaction(db, payer);
  if (
    opts.pool.payer_account_id !== payer ||
    opts.home_bay_by_account_id[payer] !== getConfiguredBayId() ||
    opts.grants.some((grant) => grant.pool_id !== opts.pool.id)
  ) {
    throw new ComputeFundingError(
      "funding_conflict",
      "Funding receipt does not match the payer and pool.",
    );
  }
  const recipients = [
    payer,
    ...opts.grants.map((g) => g.beneficiary_account_id),
  ];
  if (recipients.some((id) => !opts.home_bay_by_account_id[id])) {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Every funding receipt recipient must have a resolved home bay.",
    );
  }
  const toBudget = (row: FundingBudget) => ({
    authorized_usd: row.authorized_usd,
    spent_usd: row.spent_usd,
    reserved_usd: row.reserved_usd,
    released_usd: row.released_usd,
  });
  const pool = opts.pool;
  for (const target_account_id of new Set(recipients)) {
    const isPayer = target_account_id === payer;
    const grant = opts.grants.find(
      (g) => g.beneficiary_account_id === target_account_id,
    );
    const row = isPayer ? pool : grant!;
    const summary = {
      notice_type: "billing_course_funding_receipt",
      title: `Course compute funding ${opts.action}`,
      body_markdown: `USD ${row.authorized_usd} authorized; USD ${row.spent_usd} spent; USD ${row.reserved_usd} reserved; USD ${row.released_usd} released. Valid ${row.starts_at.toISOString()} through ${row.ends_at.toISOString()}. Status: ${row.state}. No personal payment is authorized by this sponsorship.`,
      severity: "info",
      origin_label: "Course compute billing",
      action_label: isPayer ? "View course" : "View compute",
      action_link: isPayer
        ? `/projects/${pool.course_project_id}`
        : "/hosts?tab=vms",
      funding_receipt: {
        operation_id: operation,
        action: opts.action,
        pool_id: pool.id,
        payer_account_id: payer,
        lane: pool.lane,
        currency: "USD",
        budget: toBudget(row),
        starts_at: row.starts_at.toISOString(),
        ends_at: row.ends_at.toISOString(),
        state: row.state,
        ...(isPayer
          ? {
              grants: opts.grants.map((g) => ({
                grant_id: g.id,
                beneficiary_account_id: g.beneficiary_account_id,
                ...toBudget(g),
                state: g.state,
              })),
            }
          : { grant_id: grant!.id }),
      },
    };
    const event_id = uuidv5(
      `${operation}:${pool.id}:${target_account_id}`,
      RECEIPT_NAMESPACE,
    );
    const existing = await db.query(
      "SELECT event_id FROM notification_events WHERE event_id=$1",
      [event_id],
    );
    if (existing.rows.length) continue;
    await createNotificationEventGraphInTransaction({
      db,
      input: {
        event_id,
        kind: "account_notice",
        source_bay_id: getConfiguredBayId(),
        origin_kind: "system",
        actor_account_id: payer,
        payload_json: summary,
        targets: [
          {
            target_account_id,
            target_home_bay_id: opts.home_bay_by_account_id[target_account_id],
            dedupe_key: `course-funding:${operation}:${pool.id}:${target_account_id}`,
            summary_json: summary,
          },
        ],
      },
    });
  }
}
