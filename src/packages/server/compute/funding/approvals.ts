/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { requireFundingApprovalSession } from "./approval-auth";
import { validateFundingOrigin } from "./approval-config";
import { withFundingAccountTransaction } from "./backing";
import type {
  FundingApprovalReview,
  CourseFundingApprovalTerms,
} from "./approval-review";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type { VmPersonalFundingTerms } from "@cocalc/util/compute-vm-funding";
import type { CreditTransferReceipt } from "@cocalc/util/credit-transfers";
import type {
  CourseFundingAllocationStatus,
  CourseFundingPoolChangeDraft,
} from "@cocalc/conat/hub/api/compute-funding";

export type FundingApprovalDb = PoolClient;

export interface FundingIntentStatus<Result = unknown> {
  intent_id: string;
  operation_id: string;
  approval_url: string;
  status: "pending" | "applied" | "expired";
  expires_at: string;
  terms_hash: string;
  result?: Result;
}

export interface FundingIntent<
  Terms,
  Result = unknown,
> extends FundingIntentStatus<Result> {
  payer_account_id: string;
  terms: Terms;
  review: FundingApprovalReview;
}

export interface ApplyFundingIntent<Terms> {
  db: FundingApprovalDb;
  intent_id: string;
  payer_account_id: string;
  operation_id: string;
  terms: Terms;
  review: FundingApprovalReview;
}

export interface FundingApprovalExecutor<Terms, Result> {
  withTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T>;
  apply(intent: ApplyFundingIntent<Terms>): Promise<Result>;
}

interface IntentRow {
  id: string;
  payer_account_id: string;
  operation_id: string;
  terms: unknown;
  terms_hash: string;
  review: FundingApprovalReview;
  expires_at: Date;
  applied_at: Date | null;
  result: unknown;
}

// Initialized only when the separate approval service is explicitly enabled.
export async function ensureCourseFundingApprovalSchema(): Promise<void> {
  await getPool()
    .query(`CREATE TABLE IF NOT EXISTS course_funding_approval_intents (
    id UUID PRIMARY KEY,
    payer_account_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    terms JSONB NOT NULL,
    review JSONB NOT NULL,
    terms_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    approved_session_hash TEXT,
    result JSONB,
    UNIQUE (payer_account_id, operation_id)
  )`);
  await getPool()
    .query(`CREATE INDEX IF NOT EXISTS course_funding_approval_intents_payer_created
    ON course_funding_approval_intents(payer_account_id, created_at)`);
}

export async function assertFundingPayerHomeBay(payer_account_id: string) {
  assertUuid(payer_account_id);
  const account = await getClusterAccountById(payer_account_id);
  const home_bay_id = account?.home_bay_id;
  if (!home_bay_id || home_bay_id !== getConfiguredBayId()) {
    throw Object.assign(
      new Error("Funding approval requires the payer home bay"),
      {
        code: "funding_home_bay_required",
        home_bay_id,
      },
    );
  }
}

function assertUuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Invalid funding identifier");
  }
}

// Reject lossy JSON values before hashing. Object key order is not a term change.
export function canonicalFundingTerms(value: unknown): string {
  function normalize(v: unknown, depth: number): unknown {
    if (depth > 30) throw new Error("Funding terms are too deeply nested");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
    if (
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    ) {
      throw new Error("Funding terms must be lossless JSON");
    }
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((key) => [
          key,
          normalize((v as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  }
  const json = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(json) > 256 * 1024)
    throw new Error("Funding terms are too large");
  return json;
}

export function createCourseFundingApprovals<
  Terms extends object,
  Result,
>(opts: {
  approval_origin: string;
  // Use the core CourseFundingDraft validator here, not a cast of caller JSON.
  validateTerms: (terms: unknown) => Terms;
  resolveReview: (
    payer_account_id: string,
    terms: Terms,
  ) => Promise<FundingApprovalReview>;
  // Must use db for every money/pool write; enqueue receipts in this transaction.
  apply: (intent: ApplyFundingIntent<Terms>) => Promise<Result>;
  // External verification precedes money/intent locks. A specialized executor
  // replaces (never nests) the default payer transaction, e.g. sorted transfers.
  prepare?: (
    intent: FundingIntent<Terms, Result>,
  ) => Promise<FundingApprovalExecutor<Terms, Result> | undefined>;
}) {
  const origin = validateFundingOrigin(opts.approval_origin).origin;

  function view(row: IntentRow): FundingIntent<Terms, Result> {
    return {
      intent_id: row.id,
      operation_id: row.operation_id,
      payer_account_id: row.payer_account_id,
      approval_url: `${origin}/funding/${row.id}`,
      status: row.applied_at
        ? "applied"
        : new Date(row.expires_at).valueOf() <= Date.now()
          ? "expired"
          : "pending",
      expires_at: new Date(row.expires_at).toISOString(),
      terms_hash: row.terms_hash,
      terms: row.terms as Terms,
      review: row.review,
      ...(row.applied_at ? { result: row.result as Result } : {}),
    };
  }

  async function retrieve({
    payer_account_id,
    intent_id,
  }: {
    payer_account_id: string;
    intent_id: string;
  }): Promise<FundingIntent<Terms, Result>> {
    await assertFundingPayerHomeBay(payer_account_id);
    assertUuid(intent_id);
    const { rows } = await getPool().query<IntentRow>(
      "SELECT * FROM course_funding_approval_intents WHERE id=$1 AND payer_account_id=$2",
      [intent_id, payer_account_id],
    );
    if (!rows[0]) throw new Error("Funding intent not found");
    return view(rows[0]);
  }

  async function status(
    args: Parameters<typeof retrieve>[0],
  ): Promise<FundingIntentStatus<Result>> {
    const {
      terms: _terms,
      review: _review,
      payer_account_id: _payer,
      ...result
    } = await retrieve(args);
    return result;
  }

  async function statusByOperation({
    payer_account_id,
    operation_id,
  }: {
    payer_account_id: string;
    operation_id: string;
  }): Promise<FundingIntentStatus<Result>> {
    await assertFundingPayerHomeBay(payer_account_id);
    assertUuid(operation_id);
    const { rows } = await getPool().query<{ id: string }>(
      "SELECT id FROM course_funding_approval_intents WHERE payer_account_id=$1 AND operation_id=$2",
      [payer_account_id, operation_id],
    );
    if (!rows[0]) throw new Error("Funding intent not found");
    return await status({ payer_account_id, intent_id: rows[0].id });
  }

  async function propose({
    payer_account_id,
    terms,
    operation_id,
  }: {
    payer_account_id: string;
    terms: Terms;
    operation_id: string;
  }): Promise<FundingIntentStatus<Result>> {
    await assertFundingPayerHomeBay(payer_account_id);
    assertUuid(operation_id);
    const json = canonicalFundingTerms(opts.validateTerms(terms));
    const prior = await getPool().query<IntentRow>(
      "SELECT * FROM course_funding_approval_intents WHERE payer_account_id=$1 AND operation_id=$2",
      [payer_account_id, operation_id],
    );
    if (prior.rows[0]) {
      if (canonicalFundingTerms(prior.rows[0].terms) !== json)
        throw new Error(
          "Funding operation terms changed; use a new operation_id",
        );
      const {
        terms: _terms,
        review: _review,
        payer_account_id: _payer,
        ...result
      } = view(prior.rows[0]);
      return result;
    }
    const review = await opts.resolveReview(payer_account_id, JSON.parse(json));
    const terms_hash = createHash("sha256")
      .update(canonicalFundingTerms({ terms: JSON.parse(json), review }))
      .digest("hex");
    return withAccountRehomeWriteFence({
      account_id: payer_account_id,
      action: "propose course funding",
      fn: async (db) => {
        const prior = await db.query(
          "SELECT * FROM course_funding_approval_intents WHERE payer_account_id=$1 AND operation_id=$2",
          [payer_account_id, operation_id],
        );
        if (prior.rows[0]) {
          if (canonicalFundingTerms(prior.rows[0].terms) !== json)
            throw new Error(
              "Funding operation terms changed; use a new operation_id",
            );
          const {
            terms: _terms,
            review: _review,
            payer_account_id: _payer,
            ...result
          } = view(prior.rows[0]);
          return result;
        }
        const { rows: counts } = await db.query(
          "SELECT count(*)::int AS count FROM course_funding_approval_intents WHERE payer_account_id=$1 AND created_at > now() - interval '1 hour'",
          [payer_account_id],
        );
        if (counts[0].count >= 30)
          throw new Error("Too many funding proposals");
        const { rows } = await db.query(
          `INSERT INTO course_funding_approval_intents
          (id,payer_account_id,operation_id,terms,terms_hash,review,expires_at)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,now() + interval '15 minutes') RETURNING *`,
          [
            randomUUID(),
            payer_account_id,
            operation_id,
            json,
            terms_hash,
            JSON.stringify(review),
          ],
        );
        const {
          terms: _terms,
          review: _review,
          payer_account_id: _payer,
          ...result
        } = view(rows[0]);
        return result;
      },
    });
  }

  // Server-only. The isolated HTTP surface authenticates/CSRF-checks the caller.
  // Never expose this method as a course RPC, agent method, or generic HTTP API.
  async function approve(args: {
    payer_account_id: string;
    intent_id: string;
    terms_hash: string;
    approved_session_hash: string;
  }): Promise<FundingIntentStatus<Result>> {
    await assertFundingPayerHomeBay(args.payer_account_id);
    assertUuid(args.intent_id);
    await requireFundingApprovalSession({
      session_hash: args.approved_session_hash,
      payer_account_id: args.payer_account_id,
      intent_id: args.intent_id,
      origin,
    });
    let executor: FundingApprovalExecutor<Terms, Result> | undefined;
    if (opts.prepare) {
      const intent = await retrieve(args);
      if (intent.terms_hash !== args.terms_hash || intent.status !== "pending")
        throw new Error("Funding approval is unavailable or terms changed");
      executor = await opts.prepare(intent);
    }
    const withTransaction = executor
      ? <T>(fn: (db: PoolClient) => Promise<T>) => executor!.withTransaction(fn)
      : <T>(fn: (db: PoolClient) => Promise<T>) =>
          withFundingAccountTransaction(args.payer_account_id, fn);
    return withTransaction(async (db) => {
      await requireFundingApprovalSession({
        db,
        session_hash: args.approved_session_hash,
        payer_account_id: args.payer_account_id,
        intent_id: args.intent_id,
        origin,
      });
      const account = await db.query(
        "SELECT banned, deleted FROM accounts WHERE account_id=$1",
        [args.payer_account_id],
      );
      if (
        !account.rows[0] ||
        account.rows[0].banned ||
        account.rows[0].deleted
      ) {
        throw new Error("Funding approval unavailable for this account");
      }
      const { rows } = await db.query(
        "SELECT * FROM course_funding_approval_intents WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
        [args.intent_id, args.payer_account_id],
      );
      const row: IntentRow | undefined = rows[0];
      if (!row || row.terms_hash !== args.terms_hash)
        throw new Error("Funding intent not found or terms changed");
      if (row.applied_at) throw new Error("Funding approval already consumed");
      if (new Date(row.expires_at).valueOf() <= Date.now())
        throw new Error("Funding approval expired");
      const terms = opts.validateTerms(row.terms);
      const hash = createHash("sha256")
        .update(canonicalFundingTerms({ terms, review: row.review }))
        .digest("hex");
      if (hash !== row.terms_hash)
        throw new Error(
          "Funding terms validation changed; create a new intent",
        );
      const claim = await db.query(
        `UPDATE course_funding_approval_intents SET approved_session_hash=$2
         WHERE id=$1 AND applied_at IS NULL AND approved_session_hash IS NULL RETURNING id`,
        [row.id, args.approved_session_hash],
      );
      if (claim.rows.length !== 1)
        throw new Error("Funding approval already consumed");
      const result = await (executor?.apply ?? opts.apply)({
        db,
        terms,
        review: row.review,
        payer_account_id: row.payer_account_id,
        operation_id: row.operation_id,
        intent_id: row.id,
      });
      const updated = await db.query(
        `UPDATE course_funding_approval_intents SET applied_at=now(),
          approved_session_hash=$2,result=$3::jsonb WHERE id=$1 RETURNING *`,
        [row.id, args.approved_session_hash, JSON.stringify(result ?? null)],
      );
      const {
        terms: _terms,
        review: _review,
        payer_account_id: _payer,
        ...response
      } = view(updated.rows[0]);
      return response;
    });
  }
  return {
    propose,
    retrieve,
    status,
    statusByOperation,
    approve,
    approval_origin: origin,
  };
}

export type CourseFundingApprovals<Terms extends object, Result> = ReturnType<
  typeof createCourseFundingApprovals<Terms, Result>
>;

export type FinancialApprovalResult =
  | { pool_id: string }
  | { consent_id: string }
  | { receipt: CreditTransferReceipt };

let active:
  | CourseFundingApprovals<CourseFundingApprovalTerms, FinancialApprovalResult>
  | undefined;

// Startup installs this only after its dedicated listener is accepting requests.
export function registerCourseFundingApprovalService(
  service: NonNullable<typeof active>,
): () => void {
  if (active)
    throw new Error("Financial approval listener is already registered");
  active = service;
  return () => {
    if (active === service) active = undefined;
  };
}

function allocationStatus(
  result: FundingIntentStatus<FinancialApprovalResult>,
): CourseFundingAllocationStatus {
  return {
    id: result.intent_id,
    approval_url: result.approval_url,
    status: result.status === "applied" ? "approved" : result.status,
    expires_at: result.expires_at,
    ...(result.result && "pool_id" in result.result
      ? { pool_id: result.result.pool_id }
      : {}),
  };
}

export async function proposeCourseFundingAllocation(opts: {
  payer_account_id: string;
  operation_id: string;
  terms: CourseFundingDraft;
}): Promise<CourseFundingAllocationStatus> {
  if (!active)
    throw new Error("Trusted financial approval is not configured on this bay");
  return allocationStatus(await active.propose(opts));
}

export async function getCourseFundingAllocationStatus(opts: {
  payer_account_id: string;
  intent_id: string;
}): Promise<CourseFundingAllocationStatus> {
  if (!active)
    throw new Error("Trusted financial approval is not configured on this bay");
  return allocationStatus(await active.status(opts));
}

export async function proposeCourseFundingPoolChange(opts: {
  payer_account_id: string;
  operation_id: string;
  terms: CourseFundingPoolChangeDraft;
}): Promise<CourseFundingAllocationStatus> {
  if (!active)
    throw new Error("Trusted financial approval is not configured on this bay");
  return allocationStatus(await active.propose(opts));
}

export async function proposeVmPersonalFundingApproval(opts: {
  payer_account_id: string;
  operation_id: string;
  terms: VmPersonalFundingTerms;
}): Promise<FundingIntentStatus<FinancialApprovalResult>> {
  if (!active)
    throw new Error("Trusted financial approval is not configured on this bay");
  return await active.propose({
    ...opts,
    terms: { ...opts.terms, kind: "personalVMfallback" },
  });
}

export async function proposeVolumePersonalFundingApproval(opts: {
  payer_account_id: string;
  operation_id: string;
  terms: import("@cocalc/util/compute-volume-personal-funding").VolumePersonalFundingTerms;
}): Promise<FundingIntentStatus<FinancialApprovalResult>> {
  if (!active)
    throw Error("Trusted financial approval is not configured on this bay");
  return active.propose({
    ...opts,
    terms: { ...opts.terms, kind: "personalVolumeFunding" },
  });
}

export async function getVmPersonalFundingApprovalStatus(opts: {
  payer_account_id: string;
  intent_id: string;
}): Promise<FundingIntentStatus<FinancialApprovalResult>> {
  if (!active)
    throw new Error("Trusted financial approval is not configured on this bay");
  const intent = await active.retrieve(opts);
  if (!("kind" in intent.terms) || intent.terms.kind !== "personalVMfallback")
    throw new Error("Not a personal VM funding intent");
  return await active.status(opts);
}
