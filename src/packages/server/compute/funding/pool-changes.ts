/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  CourseFundingGrantChange,
  CourseFundingPoolChangeDraft,
  CourseFundingPoolChangePreview,
  CourseFundingPoolSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import {
  ComputeFundingError,
  fundingAmount,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";
import type { FundingBudget } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  requireFundingAccountTransaction,
  reduceAccountFundingBacking,
} from "./backing";
import { getComputeFundingPolicyInTransaction } from "./policy";
import type { CourseFundingGrantRow, CourseFundingPoolRow } from "./pools";
import { enqueueCourseFundingReceiptInTransaction } from "./receipts";

function invalid(message: string): never {
  throw new ComputeFundingError("invalid_funding_request", message);
}

function poolChangeRequestHash(terms: CourseFundingPoolChangeDraft): string {
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    invalid("A current funding version is required.");
  return value as number;
}

function changes(value: {
  amount_usd?: string;
  starts_at?: string;
  ends_at?: string;
}) {
  return {
    ...(value.amount_usd === undefined
      ? {}
      : {
          amount_usd: fundingAmount(value.amount_usd, {
            positive: true,
            cents: true,
          }),
        }),
    ...(value.starts_at === undefined
      ? {}
      : { starts_at: fundingDate(value.starts_at) }),
    ...(value.ends_at === undefined
      ? {}
      : { ends_at: fundingDate(value.ends_at) }),
  };
}

export function normalizeCourseFundingPoolChangeDraft(
  value: CourseFundingPoolChangeDraft,
): CourseFundingPoolChangeDraft {
  if (!value || !["revise", "close"].includes(value.action))
    invalid("Choose a funding pool revision or closure.");
  if (
    value.grants !== undefined &&
    (!Array.isArray(value.grants) || value.grants.length > 1000)
  )
    invalid("A pool change supports at most 1000 grants.");
  const seen = new Set<string>();
  const grants = (value.grants ?? [])
    .map((grant): CourseFundingGrantChange => {
      if (!grant || !["revise", "revoke"].includes(grant.action))
        invalid("Choose a grant revision or revocation.");
      const grant_id = fundingId(grant.grant_id, "Grant");
      if (seen.has(grant_id))
        invalid("Each grant may be changed only once per operation.");
      seen.add(grant_id);
      const normalized = changes(grant);
      if (grant.action === "revoke" && Object.keys(normalized).length)
        invalid("Revocation cannot also change budget or dates.");
      if (grant.action === "revise" && !Object.keys(normalized).length)
        invalid("A grant revision must change budget or dates.");
      return {
        grant_id,
        expected_version: version(grant.expected_version),
        action: grant.action,
        ...normalized,
      };
    })
    .sort((a, b) => a.grant_id.localeCompare(b.grant_id));
  const normalized = changes(value);
  if (
    value.action === "close" &&
    (Object.keys(normalized).length || grants.length)
  )
    invalid("Pool closure cannot include other changes.");
  if (
    value.action === "revise" &&
    !Object.keys(normalized).length &&
    !grants.length
  )
    invalid("A pool revision must include changes.");
  return {
    course_project_id: fundingId(value.course_project_id, "Course project"),
    course_instance_id: fundingId(value.course_instance_id, "Course instance"),
    pool_id: fundingId(value.pool_id, "Pool"),
    expected_version: version(value.expected_version),
    action: value.action,
    ...normalized,
    ...(grants.length ? { grants } : {}),
  };
}

function reviseBudget<T extends FundingBudget>(row: T, amount?: string): T {
  if (amount === undefined) return { ...row };
  const desired = toDecimal(amount);
  if (desired.lt(toDecimal(row.spent_usd).plus(row.reserved_usd)))
    invalid("A budget cannot be reduced below spent and reserved liabilities.");
  const delta = desired.minus(
    toDecimal(row.authorized_usd).minus(row.released_usd),
  );
  return {
    ...row,
    // Releases are irreversible history; an increase adds new authorization.
    authorized_usd: moneyToDbString(
      toDecimal(row.authorized_usd).plus(delta.gt(0) ? delta : 0),
    ),
    released_usd: moneyToDbString(
      toDecimal(row.released_usd).minus(delta.lt(0) ? delta : 0),
    ),
  };
}

function releaseUnused<T extends FundingBudget>(row: T): T {
  return {
    ...row,
    released_usd: moneyToDbString(
      toDecimal(row.authorized_usd)
        .minus(row.spent_usd)
        .minus(row.reserved_usd),
    ),
  };
}

function reviseDates<
  T extends FundingBudget & { starts_at: Date; ends_at: Date },
>(row: T, change: { starts_at?: string; ends_at?: string }): T {
  const starts_at = change.starts_at
    ? new Date(change.starts_at)
    : row.starts_at;
  const ends_at = change.ends_at ? new Date(change.ends_at) : row.ends_at;
  if (starts_at >= ends_at) invalid("Funding must end after it starts.");
  if (
    toDecimal(row.reserved_usd).gt(0) &&
    (starts_at > row.starts_at || ends_at < row.ends_at)
  )
    invalid(
      "Settle outstanding resource liabilities before shortening funding dates.",
    );
  return { ...row, starts_at, ends_at };
}

function publicPool(
  pool: CourseFundingPoolRow,
  grants: CourseFundingGrantRow[],
): CourseFundingPoolSummary {
  const budget = (row: FundingBudget) => ({
    authorized_usd: row.authorized_usd,
    spent_usd: row.spent_usd,
    reserved_usd: row.reserved_usd,
    released_usd: row.released_usd,
  });
  return {
    id: pool.id,
    state: pool.state,
    lane: pool.lane,
    version: pool.version,
    allow_overcommit: pool.allow_overcommit,
    approval_limit_usd:
      pool.approval_limit_usd ??
      moneyToDbString(toDecimal(pool.authorized_usd).minus(pool.released_usd)),
    approval_starts_at: (
      pool.approval_starts_at ?? pool.starts_at
    ).toISOString(),
    approval_ends_at: (pool.approval_ends_at ?? pool.ends_at).toISOString(),
    ...budget(pool),
    starts_at: pool.starts_at.toISOString(),
    ends_at: pool.ends_at.toISOString(),
    grants: grants.map((g) => ({
      id: g.id,
      beneficiary_account_id: g.beneficiary_account_id,
      state: g.state,
      version: g.version,
      ...budget(g),
      starts_at: g.starts_at.toISOString(),
      ends_at: g.ends_at.toISOString(),
    })),
  };
}

async function plan(
  db: PoolClient,
  payer: string,
  terms: CourseFundingPoolChangeDraft,
) {
  requireFundingAccountTransaction(db, payer);
  const {
    rows: [current],
  } = await db.query<CourseFundingPoolRow>(
    `SELECT * FROM compute_funding_pools WHERE id=$1 AND payer_account_id=$2
       AND course_project_id=$3 AND course_instance_id=$4 FOR UPDATE`,
    [terms.pool_id, payer, terms.course_project_id, terms.course_instance_id],
  );
  if (!current)
    throw new ComputeFundingError(
      "funding_not_found",
      "Funding pool not found.",
    );
  if (current.version !== terms.expected_version)
    throw new ComputeFundingError(
      "funding_conflict",
      "The funding pool changed; review a new preview.",
    );
  if (!["active", "scheduled", "suspended"].includes(current.state))
    invalid("A closing or closed pool cannot be revised.");
  const { rows: currentGrants } = await db.query<CourseFundingGrantRow>(
    "SELECT * FROM compute_funding_grants WHERE pool_id=$1 ORDER BY id FOR UPDATE",
    [current.id],
  );
  const {
    rows: [clock],
  } = await db.query<{ as_of: Date }>("SELECT clock_timestamp() AS as_of");
  let pool = { ...current, version: current.version + 1 };
  let grants = currentGrants.map((g) => ({ ...g }));
  let available_backing_usd: string | undefined;
  if (terms.action === "close") {
    pool = {
      ...releaseUnused(pool),
      state: toDecimal(pool.reserved_usd).isZero() ? "closed" : "closing",
    };
    grants = grants.map((g) => ({
      ...releaseUnused(g),
      state: "revoked",
      version: g.version + 1,
    }));
  } else {
    pool = reviseDates(reviseBudget(pool, terms.amount_usd), terms);
    const byId = new Map(grants.map((g) => [g.id, g]));
    for (const change of terms.grants ?? []) {
      const grant = byId.get(change.grant_id);
      if (!grant) invalid("The changed grant does not belong to this pool.");
      if (grant.version !== change.expected_version)
        throw new ComputeFundingError(
          "funding_conflict",
          "A student grant changed; review a new preview.",
        );
      if (grant.state === "revoked")
        invalid("A revoked grant cannot be revived; create a new allocation.");
      const updated =
        change.action === "revoke"
          ? { ...releaseUnused(grant), state: "revoked" as const }
          : reviseDates(reviseBudget(grant, change.amount_usd), change);
      byId.set(grant.id, { ...updated, version: grant.version + 1 });
    }
    grants = grants.map((g) => byId.get(g.id)!);
    for (const grant of grants) {
      if (
        grant.state !== "revoked" &&
        (grant.starts_at < pool.starts_at || grant.ends_at > pool.ends_at)
      )
        invalid("Grant dates must fit within the pool interval.");
      if (grant.state !== "revoked") {
        const previousState = grant.state;
        grant.state =
          grant.ends_at <= clock.as_of
            ? "expired"
            : toDecimal(grant.authorized_usd)
                  .minus(grant.released_usd)
                  .lte(grant.spent_usd)
              ? "exhausted"
              : grant.starts_at > clock.as_of
                ? "scheduled"
                : "active";
        if (
          previousState !== grant.state &&
          !(terms.grants ?? []).some((change) => change.grant_id === grant.id)
        )
          grant.version += 1;
      }
    }
    if (!pool.allow_overcommit) {
      const promised = grants.reduce(
        (total, g) =>
          total.plus(toDecimal(g.authorized_usd).minus(g.released_usd)),
        toDecimal(0),
      );
      if (promised.gt(toDecimal(pool.authorized_usd).minus(pool.released_usd)))
        invalid(
          "Student ceilings exceed the pool's backing; revise the exact totals together.",
        );
    }
    if (pool.state !== "suspended")
      pool.state = pool.starts_at > clock.as_of ? "scheduled" : "active";
    const increase = toDecimal(pool.authorized_usd).minus(
      current.authorized_usd,
    );
    if (increase.gt(0)) {
      const policy = await getComputeFundingPolicyInTransaction(db, {
        payer_account_id: payer,
        lane: pool.lane,
      });
      available_backing_usd = policy.available_backing_usd;
      if (increase.gt(available_backing_usd))
        throw new ComputeFundingError(
          "insufficient_funding",
          "Not enough uncommitted backing for this pool increase.",
        );
    }
  }
  const requiresFinancialApproval =
    terms.action !== "close" &&
    !(await isInsideApprovedRectangle(db, current, pool));
  return {
    current,
    pool,
    grants,
    requires_financial_approval: requiresFinancialApproval,
    requires_course_access:
      terms.action !== "close" &&
      (expandsCommitment(current, pool) ||
        grants.some(
          (grant, i) =>
            grant.state !== "revoked" &&
            expandsCommitment(currentGrants[i], grant),
        )),
    as_of: clock.as_of.toISOString(),
    available_backing_usd,
  };
}

function expandsCommitment(
  before: FundingBudget & { starts_at: Date; ends_at: Date },
  after: FundingBudget & { starts_at: Date; ends_at: Date },
): boolean {
  return (
    toDecimal(after.authorized_usd)
      .minus(after.released_usd)
      .gt(toDecimal(before.authorized_usd).minus(before.released_usd)) ||
    after.starts_at < before.starts_at ||
    after.ends_at > before.ends_at
  );
}

interface PoolApprovalRectangle {
  amount_usd: string;
  starts_at: Date;
  ends_at: Date;
}

async function isInsideApprovedRectangle(
  db: PoolClient,
  current: CourseFundingPoolRow,
  proposed: CourseFundingPoolRow,
): Promise<boolean> {
  const { rows } = await db.query<PoolApprovalRectangle>(
    `SELECT amount_usd,starts_at,ends_at
       FROM compute_funding_pool_approvals
      WHERE pool_id=$1 AND payer_account_id=$2`,
    [current.id, current.payer_account_id],
  );
  // Existing development pools predate the rectangle table. Their prior
  // columns represent one exact approval, not independently mergeable axes.
  const approvals = rows.length
    ? rows
    : [
        {
          amount_usd:
            current.approval_limit_usd ??
            moneyToDbString(
              toDecimal(current.authorized_usd).minus(current.released_usd),
            ),
          starts_at: current.approval_starts_at ?? current.starts_at,
          ends_at: current.approval_ends_at ?? current.ends_at,
        },
      ];
  const amount = toDecimal(proposed.authorized_usd).minus(
    proposed.released_usd,
  );
  return approvals.some(
    (approval) =>
      amount.lte(approval.amount_usd) &&
      proposed.starts_at >= approval.starts_at &&
      proposed.ends_at <= approval.ends_at,
  );
}

export async function previewCourseFundingPoolChangeInTransaction(
  db: PoolClient,
  opts: { payer_account_id: string; terms: CourseFundingPoolChangeDraft },
): Promise<CourseFundingPoolChangePreview> {
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const result = await plan(
    db,
    fundingId(opts.payer_account_id, "Payer account"),
    terms,
  );
  return {
    terms,
    pool: publicPool(result.pool, result.grants),
    requires_financial_approval: result.requires_financial_approval,
    requires_course_access: result.requires_course_access,
    as_of: result.as_of,
    ...(result.available_backing_usd === undefined
      ? {}
      : { available_backing_usd: result.available_backing_usd }),
  };
}

/** Financial-approval callback only. Intent consumption supplies idempotency;
 * optimistic versions also prevent a replay from applying the same change twice.
 * Budget, backing and required receipts all use the caller's locked transaction.
 */
export async function changeCourseFundingPoolInTransaction(
  db: PoolClient,
  opts: {
    payer_account_id: string;
    operation_id: string;
    terms: CourseFundingPoolChangeDraft;
    home_bay_by_account_id: Record<string, string>;
  },
): Promise<{ pool_id: string }> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const planned = await plan(db, payer, terms);
  return await applyPlannedPoolChange(db, {
    payer,
    operation_id: opts.operation_id,
    terms,
    home_bay_by_account_id: opts.home_bay_by_account_id,
    planned,
    extend_approval_envelope: true,
  });
}

async function applyPlannedPoolChange(
  db: PoolClient,
  opts: {
    payer: string;
    operation_id: string;
    terms: CourseFundingPoolChangeDraft;
    home_bay_by_account_id: Record<string, string>;
    planned: Awaited<ReturnType<typeof plan>>;
    extend_approval_envelope?: boolean;
  },
): Promise<{ pool_id: string }> {
  const { payer, terms, planned } = opts;
  const { current, pool, grants } = planned;
  pool.approval_limit_usd ??= moneyToDbString(
    toDecimal(current.authorized_usd).minus(current.released_usd),
  );
  pool.approval_starts_at ??= current.starts_at;
  pool.approval_ends_at ??= current.ends_at;
  if (opts.extend_approval_envelope && planned.requires_financial_approval) {
    const requestedLimit = toDecimal(pool.authorized_usd).minus(
      pool.released_usd,
    );
    // Preserve a legacy pool's prior exact rectangle before replacing the
    // compatibility columns with the newly reviewed rectangle.
    await db.query(
      `INSERT INTO compute_funding_pool_approvals
         (id,pool_id,payer_account_id,operation_id,amount_usd,starts_at,ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pool_id,operation_id) DO NOTHING`,
      [
        randomUUID(),
        current.id,
        payer,
        current.operation_id,
        current.approval_limit_usd ??
          moneyToDbString(
            toDecimal(current.authorized_usd).minus(current.released_usd),
          ),
        current.approval_starts_at ?? current.starts_at,
        current.approval_ends_at ?? current.ends_at,
      ],
    );
    await db.query(
      `INSERT INTO compute_funding_pool_approvals
         (id,pool_id,payer_account_id,operation_id,amount_usd,starts_at,ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pool_id,operation_id) DO NOTHING`,
      [
        randomUUID(),
        current.id,
        payer,
        opts.operation_id,
        moneyToDbString(requestedLimit),
        pool.starts_at,
        pool.ends_at,
      ],
    );
    pool.approval_limit_usd = moneyToDbString(requestedLimit);
    pool.approval_starts_at = pool.starts_at;
    pool.approval_ends_at = pool.ends_at;
  }
  const added = toDecimal(pool.authorized_usd).minus(current.authorized_usd);
  if (added.gt(0)) {
    const { rows } = await db.query(
      "UPDATE account_funding_holds SET authorized_usd=authorized_usd+$3,remaining_usd=remaining_usd+$3,updated_at=clock_timestamp() WHERE id=$1 AND payer_account_id=$2 RETURNING id",
      [pool.hold_id, payer, moneyToDbString(added)],
    );
    if (rows.length !== 1)
      throw new ComputeFundingError(
        "funding_conflict",
        "Pool backing is missing.",
      );
  }
  const released = toDecimal(pool.released_usd).minus(current.released_usd);
  if (released.gt(0))
    await reduceAccountFundingBacking(db, {
      payer_account_id: payer,
      hold_id: pool.hold_id,
      amount_usd: moneyToDbString(released),
    });
  await db.query(
    `UPDATE compute_funding_pools SET authorized_usd=$3,released_usd=$4,starts_at=$5,ends_at=$6,state=$7,version=$8,
       approval_limit_usd=$9,approval_starts_at=$10,approval_ends_at=$11,updated_at=clock_timestamp()
    WHERE id=$1 AND payer_account_id=$2`,
    [
      pool.id,
      payer,
      pool.authorized_usd,
      pool.released_usd,
      pool.starts_at,
      pool.ends_at,
      pool.state,
      pool.version,
      pool.approval_limit_usd,
      pool.approval_starts_at,
      pool.approval_ends_at,
    ],
  );
  for (const grant of grants) {
    await db.query(
      `UPDATE compute_funding_grants SET authorized_usd=$3,released_usd=$4,starts_at=$5,ends_at=$6,state=$7,version=$8,updated_at=clock_timestamp()
      WHERE id=$1 AND pool_id=$2`,
      [
        grant.id,
        pool.id,
        grant.authorized_usd,
        grant.released_usd,
        grant.starts_at,
        grant.ends_at,
        grant.state,
        grant.version,
      ],
    );
  }
  await enqueueCourseFundingReceiptInTransaction(db, {
    payer_account_id: payer,
    operation_id: opts.operation_id,
    action:
      terms.action === "close"
        ? pool.state === "closed"
          ? "closed"
          : "closing"
        : "revised",
    pool,
    grants,
    home_bay_by_account_id: opts.home_bay_by_account_id,
  });
  return { pool_id: pool.id };
}

/** Apply a pool edit under its existing aggregate amount/date mandate.
 * The operation journal makes an unknown network outcome safe to retry. The
 * envelope classification is recomputed while the payer and pool are locked.
 */
export async function changeCourseFundingPoolWithinEnvelopeInTransaction(
  db: PoolClient,
  opts: {
    payer_account_id: string;
    operation_id: string;
    terms: CourseFundingPoolChangeDraft;
    home_bay_by_account_id: Record<string, string>;
  },
): Promise<{ pool_id: string; completed_at: string }> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  const operation_id = fundingId(opts.operation_id, "Funding operation");
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const request_hash = poolChangeRequestHash(terms);
  const prior = await db.query<{
    request_hash: string;
    pool_id: string;
    created_at: Date;
  }>(
    `SELECT request_hash,pool_id,created_at FROM course_funding_pool_changes
      WHERE payer_account_id=$1 AND operation_id=$2`,
    [payer, operation_id],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== request_hash)
      invalid("Funding operation terms changed; use a new operation ID.");
    return {
      pool_id: prior.rows[0].pool_id,
      completed_at: prior.rows[0].created_at.toISOString(),
    };
  }
  const planned = await plan(db, payer, terms);
  if (planned.requires_financial_approval)
    throw new ComputeFundingError(
      "funding_conflict",
      "This change increases the approved course spending envelope.",
    );
  const result = await applyPlannedPoolChange(db, {
    payer,
    operation_id,
    terms,
    home_bay_by_account_id: opts.home_bay_by_account_id,
    planned,
  });
  const inserted = await db.query<{ created_at: Date }>(
    `INSERT INTO course_funding_pool_changes
      (payer_account_id,operation_id,request_hash,pool_id)
      VALUES ($1,$2,$3,$4) RETURNING created_at`,
    [payer, operation_id, request_hash, result.pool_id],
  );
  return {
    ...result,
    completed_at: inserted.rows[0].created_at.toISOString(),
  };
}

export async function getCourseFundingPoolChangeOperation(opts: {
  payer_account_id: string;
  operation_id: string;
  terms: CourseFundingPoolChangeDraft;
}): Promise<{ pool_id: string; completed_at: string } | undefined> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  const operation_id = fundingId(opts.operation_id, "Funding operation");
  const terms = normalizeCourseFundingPoolChangeDraft(opts.terms);
  const { rows } = await getPool().query<{
    request_hash: string;
    pool_id: string;
    created_at: Date;
  }>(
    `SELECT request_hash,pool_id,created_at FROM course_funding_pool_changes
      WHERE payer_account_id=$1 AND operation_id=$2`,
    [payer, operation_id],
  );
  if (!rows[0]) return;
  if (rows[0].request_hash !== poolChangeRequestHash(terms))
    invalid("Funding operation terms changed; use a new operation ID.");
  return {
    pool_id: rows[0].pool_id,
    completed_at: rows[0].created_at.toISOString(),
  };
}
