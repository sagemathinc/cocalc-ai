/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import {
  ComputeFundingError,
  fundingId,
  normalizeCourseFundingDraft,
} from "@cocalc/util/compute-funding";
import type {
  CourseFundingDraft,
  ComputeFundingLane,
  ComputeFundingPoolState,
  ComputeFundingGrantState,
  FundingBudget,
} from "@cocalc/util/compute-funding";
import {
  requireFundingAccountTransaction,
  reserveAccountFundingBacking,
} from "./backing";
import { getComputeFundingPolicyInTransaction } from "./policy";

export interface CourseFundingPoolRow extends FundingBudget {
  id: string;
  payer_account_id: string;
  hold_id: string;
  course_project_id: string;
  course_instance_id: string;
  currency: "USD";
  lane: ComputeFundingLane;
  allow_overcommit: boolean;
  approval_limit_usd: string | null;
  approval_starts_at: Date | null;
  approval_ends_at: Date | null;
  starts_at: Date;
  ends_at: Date;
  state: ComputeFundingPoolState;
  version: number;
  operation_id: string;
  request_hash: string;
}

export interface CourseFundingGrantRow extends FundingBudget {
  id: string;
  pool_id: string;
  beneficiary_account_id: string;
  starts_at: Date;
  ends_at: Date;
  state: ComputeFundingGrantState;
  version: number;
}

export interface CourseFundingAllocation {
  pool: CourseFundingPoolRow;
  grants: CourseFundingGrantRow[];
  created: boolean;
}

/** Storage primitive, not an account/project RPC. Call only after financial
 * approval and inside withFundingAccountTransaction for this payer. Backing
 * capacity is resolved from server policy under that lock.
 */
export async function createCourseFundingPoolInTransaction(
  client: PoolClient,
  opts: {
    payer_account_id: string;
    operation_id: string;
    terms: CourseFundingDraft;
  },
): Promise<CourseFundingAllocation> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  requireFundingAccountTransaction(client, payer);
  const operation = fundingId(opts.operation_id, "Allocation operation");
  const terms = normalizeCourseFundingDraft(opts.terms);
  const hash = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
  const {
    rows: [existing],
  } = await client.query<CourseFundingPoolRow>(
    "SELECT * FROM compute_funding_pools WHERE payer_account_id=$1 AND operation_id=$2 FOR UPDATE",
    [payer, operation],
  );
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeFundingError(
        "funding_conflict",
        "This allocation operation has already been used with different terms.",
      );
    const { rows: grants } = await client.query<CourseFundingGrantRow>(
      "SELECT * FROM compute_funding_grants WHERE pool_id=$1 ORDER BY beneficiary_account_id",
      [existing.id],
    );
    return { pool: existing, grants, created: false };
  }
  const {
    rows: [{ now }],
  } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  if (new Date(terms.ends_at) <= now)
    throw new ComputeFundingError(
      "invalid_funding_request",
      "The allocation has already expired.",
    );
  const state = new Date(terms.starts_at) > now ? "scheduled" : "active";
  const policy = await getComputeFundingPolicyInTransaction(client, {
    payer_account_id: payer,
    lane: terms.lane,
  });
  const id = randomUUID();
  const hold = await reserveAccountFundingBacking(client, {
    payer_account_id: payer,
    source_kind: "course-pool",
    source_id: id,
    lane: terms.lane,
    authorized_usd: terms.amount_usd,
    capacity_usd: policy.backing_capacity_usd,
  });
  const {
    rows: [pool],
  } = await client.query<CourseFundingPoolRow>(
    `INSERT INTO compute_funding_pools
       (id, payer_account_id, course_project_id, course_instance_id, hold_id,
        operation_id, request_hash, lane, authorized_usd, approval_limit_usd,
        approval_starts_at, approval_ends_at, allow_overcommit, starts_at, ends_at, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$11,$12,$10,$11,$12,$13) RETURNING *`,
    [
      id,
      payer,
      terms.course_project_id,
      terms.course_instance_id,
      hold.id,
      operation,
      hash,
      terms.lane,
      terms.amount_usd,
      terms.allow_overcommit,
      terms.starts_at,
      terms.ends_at,
      state,
    ],
  );
  const { rows: grants } = await client.query<CourseFundingGrantRow>(
    `INSERT INTO compute_funding_grants
       (id, pool_id, beneficiary_account_id, authorized_usd, starts_at, ends_at, state)
     SELECT (entry->>'id')::uuid, $1::uuid, (entry->>'beneficiary_account_id')::uuid,
       (entry->>'amount_usd')::numeric, $3::timestamp, $4::timestamp, $5::text
     FROM jsonb_array_elements($2::jsonb) AS entry
     RETURNING *`,
    [
      id,
      JSON.stringify(
        terms.recipients.map((recipient) => ({
          ...recipient,
          id: randomUUID(),
        })),
      ),
      terms.starts_at,
      terms.ends_at,
      state,
    ],
  );
  grants.sort((a, b) =>
    a.beneficiary_account_id.localeCompare(b.beneficiary_account_id),
  );
  return { pool, grants, created: true };
}
