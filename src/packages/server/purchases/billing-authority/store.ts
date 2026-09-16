/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { canonicalizeBillingValue } from "@cocalc/server/purchases/canonical-json";
import {
  adminMembershipPackageInvoiceId,
  normalizeAdminMembershipPackageBusinessIdentity,
} from "@cocalc/server/purchases/admin-membership-package-identity";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { isValidUUID } from "@cocalc/util/misc";

import type {
  BillingAuthorityCommand,
  BillingAuthorityCommandRecord,
  BillingAuthorityError,
  BillingAuthorityFenceCause,
  BillingAuthorityHealth,
  BillingAuthorityLane,
  BillingAuthoritySubmitRequest,
} from "./protocol";
import { normalizeBillingAuthorityError } from "./error-normalization";
import {
  billingAuthorityAccountIds,
  billingAuthorityAccountsAllowedWhenFrozen,
  billingAuthorityActorAccountId,
  billingAuthorityLane,
  billingAuthorityOperationName,
} from "./protocol";

const LEASE_NAME = "primary";
const ACCOUNT_FENCE_MIGRATION = "account-security-fences-v1";
const ADMISSION_LOCK = 1_111_575_378;
export const BILLING_AUTHORITY_EXECUTION_LOCK = 1_111_575_379;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 4000;
const MAX_DEDUPLICATION_MS = 24 * 60 * 60_000;
const PAYLOAD_RETENTION = "48 hours";
const AUDIT_RETENTION = "400 days";
const STRIPE_IDEMPOTENCY_RECOVERY_WINDOW = "23 hours";
const ADMIN_PACKAGE_HUB_METHOD =
  "purchases.adminCreateMembershipPackagePurchase";
const MAX_QUEUE_DEPTH: Record<BillingAuthorityLane, number> = {
  critical: 1000,
  interactive: 500,
  maintenance: 100,
};

export interface BillingAuthorityLeaseIdentity {
  instance_id: string;
  generation: number;
}

type Queryable = Pick<PoolClient, "query">;

interface LeaseRow {
  holder_id?: string | null;
  generation: number;
  lease_until?: Date | string | null;
  enabled: boolean;
  draining: boolean;
  serving?: boolean;
  handoff_exclude_holder_id?: string | null;
  lease_valid?: boolean;
}

interface CommandRow {
  command_id: string;
  request_hash: string;
  operation: string;
  lane: BillingAuthorityLane;
  account_id?: string | null;
  account_ids?: string[] | null;
  actor_account_id?: string | null;
  command: BillingAuthorityCommand;
  status: BillingAuthorityCommandRecord["status"];
  result?: unknown;
  error?: BillingAuthorityError | null;
  created_at: Date | string;
  updated_at: Date | string;
  first_started_at?: Date | string | null;
  provider_attempt_started_at?: Date | string | null;
  provider_uncertain_started_at?: Date | string | null;
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
  expires_at: Date | string;
  authority_generation?: number | null;
  attempt_count: number;
}

interface MigrationRow {
  phase: "scan" | "verify" | "complete";
  cursor_account_id?: string | null;
  processed_count: number | string;
  complete: boolean;
}

export interface BillingAuthorityActivationProgress {
  phase: MigrationRow["phase"];
  complete: boolean;
  processed_in_batch: number;
  processed_count: number;
}

function authorityError(message: string, status: number): Error {
  return Object.assign(new Error(message), { code: status, status });
}

function boundedTerminalError(
  error: BillingAuthorityError | undefined,
  status: "failed" | "uncertain",
): BillingAuthorityError {
  return normalizeBillingAuthorityError(error, {
    fallbackMessage: `billing authority command ${status}`,
    fallbackCode:
      status === "uncertain"
        ? "billing_authority_outcome_uncertain"
        : "billing_authority_command_failed",
  });
}

function iso(value?: Date | string | null): string | undefined {
  if (value == null) return undefined;
  return new Date(value).toISOString();
}

function commandRecord(
  row: CommandRow,
  reused = false,
): BillingAuthorityCommandRecord {
  return {
    command_id: row.command_id,
    operation: row.operation,
    lane: row.lane,
    ...(row.account_id ? { account_id: row.account_id } : {}),
    ...(row.account_ids?.length ? { account_ids: row.account_ids } : {}),
    ...(row.actor_account_id ? { actor_account_id: row.actor_account_id } : {}),
    status: row.status,
    ...(row.result === undefined ? {} : { result: row.result }),
    ...(row.error == null ? {} : { error: row.error }),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    ...(iso(row.started_at) ? { started_at: iso(row.started_at) } : {}),
    ...(iso(row.finished_at) ? { finished_at: iso(row.finished_at) } : {}),
    expires_at: iso(row.expires_at)!,
    ...(row.authority_generation == null
      ? {}
      : { authority_generation: row.authority_generation }),
    ...(reused ? { reused: true } : {}),
  };
}

function requestJson(request: BillingAuthoritySubmitRequest): string {
  return JSON.stringify(canonicalizeBillingValue(request.command));
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function normalizedUuidField(value: unknown): unknown {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return isValidUUID(normalized) ? normalized : value;
}

function adminPackageBusinessIdentity(
  input: Record<string, unknown>,
  actor: string,
  hubApiWireFormat = false,
):
  | ReturnType<typeof normalizeAdminMembershipPackageBusinessIdentity>
  | undefined {
  try {
    return normalizeAdminMembershipPackageBusinessIdentity({
      admin_account_id: actor,
      user_account_id: input.user_account_id,
      product: input.product as MembershipPackageProduct,
      price: hubApiWireFormat ? Number(input.price) : input.price,
      source: input.source,
      reason: hubApiWireFormat ? `${input.reason ?? ""}` : input.reason,
      idempotency_key: hubApiWireFormat
        ? `${input.idempotency_key ?? ""}`
        : input.idempotency_key,
      pricing_note: input.pricing_note,
    });
  } catch {
    return;
  }
}

function adminPackageSemanticCommand(
  command: BillingAuthorityCommand,
): BillingAuthorityCommand {
  if (
    command.kind === "account-local" &&
    command.operation === "admin-create-membership-package-purchase"
  ) {
    const actor = normalizedUuidField(command.actor_account_id);
    if (typeof actor !== "string" || !isValidUUID(actor)) return command;
    if (normalizedUuidField(command.input.admin_account_id) !== actor) {
      return command;
    }
    const businessIdentity = adminPackageBusinessIdentity(command.input, actor);
    if (!businessIdentity) return command;
    return {
      ...command,
      actor_account_id: actor,
      input: {
        ...command.input,
        admin_account_id: businessIdentity.admin_account_id,
        user_account_id: businessIdentity.user_account_id,
        product: businessIdentity.product,
        price: businessIdentity.custom_price,
        source: businessIdentity.source,
        reason: businessIdentity.reason,
        idempotency_key: businessIdentity.idempotency_key,
        pricing_note: businessIdentity.pricing_note,
      },
    };
  }
  if (
    command.kind !== "hub-api" ||
    command.call.name !== ADMIN_PACKAGE_HUB_METHOD ||
    command.call.args.length !== 1
  ) {
    return command;
  }
  const input = record(command.call.args[0]);
  if (!input) return command;
  const actor = normalizedUuidField(command.call.account_id);
  if (typeof actor !== "string" || !isValidUUID(actor)) return command;
  const call = { ...command.call };
  // Credential instances may rotate between retries. The full payload remains
  // journaled and is replayed so the Hub API revalidates the current session.
  delete call.auth_session_hash;
  delete call.auth_token_fingerprint;
  delete call.auth_iat_s;
  delete call.auth_exp_s;
  const businessIdentity = adminPackageBusinessIdentity(input, actor, true);
  if (!businessIdentity) {
    // Invalid requests cannot create a durable package intent. Keep their raw
    // business payload distinct while still allowing credentials to rotate.
    return { kind: "hub-api", call };
  }
  return {
    kind: "hub-api",
    call: {
      ...call,
      account_id: actor,
      args: [{ admin_membership_package_business_identity: businessIdentity }],
    },
  };
}

function requestHash(request: BillingAuthoritySubmitRequest): {
  hash: string;
  json: string;
} {
  const json = requestJson(request);
  if (Buffer.byteLength(json) > MAX_COMMAND_BYTES) {
    throw authorityError("billing authority command is too large", 413);
  }
  const semanticJson = JSON.stringify(
    canonicalizeBillingValue(adminPackageSemanticCommand(request.command)),
  );
  return {
    hash: createHash("sha256").update(semanticJson).digest("hex"),
    json,
  };
}

function assertValidSubmission(request: BillingAuthoritySubmitRequest): {
  expiresAt: Date;
  deduplicateForMs: number;
} {
  if (!isValidUUID(request.command_id)) {
    throw authorityError("invalid billing authority command_id", 400);
  }
  const expiresAt = new Date(request.expires_at);
  if (!Number.isFinite(expiresAt.valueOf())) {
    throw authorityError("invalid billing authority command expiry", 400);
  }
  if (expiresAt.valueOf() > Date.now() + 30 * 60_000) {
    throw authorityError(
      "billing authority command expiry is too far away",
      400,
    );
  }
  const deduplicateForMs = Number(request.deduplicate_for_ms ?? 0);
  if (
    !Number.isFinite(deduplicateForMs) ||
    deduplicateForMs < 0 ||
    deduplicateForMs > MAX_DEDUPLICATION_MS
  ) {
    throw authorityError("invalid billing command deduplication window", 400);
  }
  return { expiresAt, deduplicateForMs: Math.floor(deduplicateForMs) };
}

async function withTransaction<T>(
  fn: (db: Queryable) => Promise<T>,
  suppliedDb?: Queryable,
): Promise<T> {
  const ownedDb = suppliedDb == null ? await getPool().connect() : undefined;
  const db = suppliedDb ?? ownedDb!;
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    ownedDb?.release();
  }
}

async function existingCommand(
  db: Pick<PoolClient, "query">,
  commandId: string,
): Promise<CommandRow | undefined> {
  const { rows } = await db.query<CommandRow>(
    "SELECT * FROM billing_authority_commands WHERE command_id=$1",
    [commandId],
  );
  return rows[0];
}

function adminPackageRecoveryIdentity(command: BillingAuthorityCommand):
  | {
      account_id: string;
      admin_account_id: string;
      invoice_id: string;
      source: "card" | "credit" | "free";
    }
  | undefined {
  let input: Record<string, unknown>;
  let adminAccountId: unknown;
  if (
    command.kind === "account-local" &&
    command.operation === "admin-create-membership-package-purchase"
  ) {
    input = command.input;
    adminAccountId = input.admin_account_id;
  } else if (
    command.kind === "hub-api" &&
    command.call.name === ADMIN_PACKAGE_HUB_METHOD &&
    command.call.args.length === 1 &&
    !command.call.project_id &&
    !command.call.host_id &&
    !command.call.auth_actor
  ) {
    const hubInput = record(command.call.args[0]);
    if (!hubInput) return;
    input = hubInput;
    adminAccountId = command.call.account_id;
  } else {
    return;
  }
  const source = `${input.source ?? ""}`;
  const account_id = `${input.user_account_id ?? ""}`.trim().toLowerCase();
  const admin_account_id = `${adminAccountId ?? ""}`.trim().toLowerCase();
  const idempotency_key = `${input.idempotency_key ?? ""}`.trim();
  const actor = billingAuthorityActorAccountId(command);
  if (
    !isValidUUID(account_id) ||
    !isValidUUID(admin_account_id) ||
    actor !== admin_account_id.toLowerCase() ||
    !["card", "credit", "free"].includes(source) ||
    !idempotency_key ||
    idempotency_key.length > 120
  ) {
    return;
  }
  return {
    account_id,
    admin_account_id,
    source: source as "card" | "credit" | "free",
    invoice_id: adminMembershipPackageInvoiceId(
      admin_account_id,
      idempotency_key,
    ),
  };
}

async function canRecoverAdminPackage(
  db: Queryable,
  existing: CommandRow,
  command: BillingAuthorityCommand,
): Promise<boolean> {
  if (existing.attempt_count < 1) return false;
  const identity = adminPackageRecoveryIdentity(command);
  if (!identity) return false;
  const { rows } = await db.query<{
    has_intent: boolean;
    has_purchase: boolean;
    provider_key_retained: boolean;
  }>(
    `SELECT EXISTS (
              SELECT 1
                FROM admin_membership_package_intents
               WHERE invoice_id=$1 AND account_id=$2
                 AND admin_account_id=$3
            ) AS has_intent,
            EXISTS (
              SELECT 1
                FROM purchases
               WHERE invoice_id=$1 AND account_id=$2
                 AND service='membership'
                 AND description->>'type'='membership-package'
                 AND NULLIF(description->>'package_id', '') IS NOT NULL
            ) AS has_purchase,
            $4::TIMESTAMPTZ IS NOT NULL
              AND $4::TIMESTAMPTZ >=
                clock_timestamp() - INTERVAL '${STRIPE_IDEMPOTENCY_RECOVERY_WINDOW}'
              AS provider_key_retained`,
    [
      identity.invoice_id,
      identity.account_id,
      identity.admin_account_id,
      existing.provider_uncertain_started_at ?? null,
    ],
  );
  const state = rows[0];
  if (state?.has_purchase) return true;
  if (!state?.has_intent) {
    return (
      existing.provider_attempt_started_at == null &&
      existing.provider_uncertain_started_at == null
    );
  }
  if (identity.source !== "card") return true;
  // No unresolved guarded Stripe mutation exists without this durable anchor.
  // Pre-provider and definitive provider failures can retry at any age.
  if (!existing.provider_uncertain_started_at) return true;
  return state.provider_key_retained;
}

async function assertBillingAccountsAllowed(
  db: Queryable,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT account_id
       FROM (
         SELECT account_id
           FROM billing_authority_account_fences
          WHERE account_id=ANY($1::UUID[]) AND frozen
         UNION ALL
         SELECT account_id
           FROM accounts
          WHERE account_id=ANY($1::UUID[])
            AND (banned IS TRUE OR deleted IS TRUE)
       ) AS blocked
      LIMIT 1`,
    [accountIds],
  );
  if (rows[0]) {
    throw authorityError("billing is frozen for this account", 423);
  }
}

const MISSING_ACCOUNT_FENCE_SQL = `
  (accounts.banned IS TRUE
   AND (NOT COALESCE(fences.frozen, FALSE)
        OR NOT (COALESCE(fences.causes, '{}'::JSONB) ? 'ban')))
  OR
  (accounts.deleted IS TRUE
   AND (NOT COALESCE(fences.frozen, FALSE)
        OR NOT (COALESCE(fences.causes, '{}'::JSONB) ? 'deletion')))`;

async function migrateAccountFenceBatch({
  db,
  phase,
  cursor,
  batchSize,
}: {
  db: Queryable;
  phase: "scan" | "verify";
  cursor?: string | null;
  batchSize: number;
}): Promise<{ candidate_count: number; last_account_id?: string }> {
  const phasePredicate =
    phase === "scan"
      ? "AND ($2::UUID IS NULL OR accounts.account_id > $2::UUID)"
      : `AND (${MISSING_ACCOUNT_FENCE_SQL})`;
  const params = phase === "scan" ? [batchSize, cursor ?? null] : [batchSize];
  const { rows } = await db.query<{
    candidate_count: number | string;
    last_account_id?: string | null;
  }>(
    `WITH candidates AS MATERIALIZED (
       SELECT accounts.account_id, accounts.banned, accounts.deleted,
              accounts.banned_at
         FROM accounts
         LEFT JOIN billing_authority_account_fences AS fences
           ON fences.account_id=accounts.account_id
        WHERE (accounts.banned IS TRUE OR accounts.deleted IS TRUE)
          ${phasePredicate}
        ORDER BY accounts.account_id
        LIMIT $1
     ), upserted AS (
       INSERT INTO billing_authority_account_fences
         (account_id, frozen, reason, causes, actor_account_id, generation,
          created_at, updated_at)
       SELECT account_id, TRUE,
              CASE WHEN banned IS TRUE AND deleted IS TRUE
                     THEN 'account was banned and deleted before authority activation'
                   WHEN banned IS TRUE
                     THEN 'account was banned before authority activation'
                   ELSE 'account was deleted before authority activation'
               END,
              (CASE WHEN banned IS TRUE THEN
                 jsonb_build_object(
                   'ban', jsonb_build_object(
                     'reason', 'authoritative account ban',
                     'actor_account_id', NULL,
                     'updated_at', COALESCE(banned_at, clock_timestamp())))
               ELSE '{}'::JSONB END)
              ||
              (CASE WHEN deleted IS TRUE THEN
                 jsonb_build_object(
                   'deletion', jsonb_build_object(
                     'reason', 'authoritative account deletion',
                     'actor_account_id', NULL,
                     'updated_at', clock_timestamp()))
               ELSE '{}'::JSONB END),
              NULL, 1, clock_timestamp(), clock_timestamp()
         FROM candidates
       ON CONFLICT (account_id) DO UPDATE
         SET frozen=TRUE,
             causes=EXCLUDED.causes
                      || COALESCE(
                           billing_authority_account_fences.causes,
                           '{}'::JSONB),
             reason=EXCLUDED.reason,
             generation=billing_authority_account_fences.generation + 1,
             updated_at=clock_timestamp()
       WHERE NOT billing_authority_account_fences.frozen
          OR (EXCLUDED.causes ? 'ban'
              AND NOT (COALESCE(
                billing_authority_account_fences.causes,
                '{}'::JSONB) ? 'ban'))
          OR (EXCLUDED.causes ? 'deletion'
              AND NOT (COALESCE(
                billing_authority_account_fences.causes,
                '{}'::JSONB) ? 'deletion'))
       RETURNING account_id
     )
     SELECT COUNT(*)::INT AS candidate_count,
            (SELECT account_id::TEXT
               FROM candidates
              ORDER BY account_id DESC LIMIT 1) AS last_account_id
       FROM candidates`,
    params,
  );
  return {
    candidate_count: Number(rows[0]?.candidate_count ?? 0),
    ...(rows[0]?.last_account_id
      ? { last_account_id: rows[0].last_account_id }
      : {}),
  };
}

async function hasMissingAccountSecurityFence(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1
       FROM accounts
       LEFT JOIN billing_authority_account_fences AS fences
         ON fences.account_id=accounts.account_id
      WHERE ${MISSING_ACCOUNT_FENCE_SQL}
      LIMIT 1`,
  );
  return !!rows[0];
}

export async function advanceBillingAuthorityActivation({
  batch_size = 5_000,
  db,
}: {
  batch_size?: number;
  db?: Queryable;
} = {}): Promise<BillingAuthorityActivationProgress> {
  const batchSize = Math.floor(Number(batch_size));
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25_000) {
    throw authorityError("invalid billing authority migration batch size", 400);
  }
  return await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    await db.query(
      `INSERT INTO billing_authority_migrations
         (name, phase, processed_count, complete, started_at, updated_at)
       VALUES ($1, 'scan', 0, FALSE, clock_timestamp(), clock_timestamp())
       ON CONFLICT (name) DO NOTHING`,
      [ACCOUNT_FENCE_MIGRATION],
    );
    const { rows } = await db.query<MigrationRow>(
      `SELECT phase, cursor_account_id, processed_count, complete
         FROM billing_authority_migrations
        WHERE name=$1
        FOR UPDATE`,
      [ACCOUNT_FENCE_MIGRATION],
    );
    const progress = rows[0];
    if (!progress) {
      throw authorityError("billing authority migration state is missing", 503);
    }
    if (progress.complete) {
      return {
        phase: "complete",
        complete: true,
        processed_in_batch: 0,
        processed_count: Number(progress.processed_count),
      };
    }
    const phase = progress.phase === "scan" ? "scan" : "verify";
    const batch = await migrateAccountFenceBatch({
      db,
      phase,
      cursor: progress.cursor_account_id,
      batchSize,
    });
    let nextPhase: MigrationRow["phase"] = phase;
    if (phase === "scan" && batch.candidate_count < batchSize) {
      nextPhase = "verify";
    }
    const processedCount =
      Number(progress.processed_count) + batch.candidate_count;
    await db.query(
      `UPDATE billing_authority_migrations
          SET phase=$2::TEXT,
              cursor_account_id=CASE
                WHEN $2::TEXT='scan' THEN $3::UUID
                ELSE cursor_account_id
              END,
              processed_count=$4::BIGINT,
              updated_at=clock_timestamp()
        WHERE name=$1`,
      [
        ACCOUNT_FENCE_MIGRATION,
        nextPhase,
        batch.last_account_id ?? progress.cursor_account_id ?? null,
        processedCount,
      ],
    );

    if (nextPhase === "verify" && batch.candidate_count === 0) {
      // Account lifecycle writes take ROW EXCLUSIVE. This final SHARE lock and
      // the admission lock make the no-missing-row observation and completion
      // marker one atomic activation boundary.
      await db.query("LOCK TABLE accounts IN SHARE MODE");
      if (!(await hasMissingAccountSecurityFence(db))) {
        await db.query(
          `UPDATE billing_authority_migrations
              SET phase='complete', complete=TRUE,
                  completed_at=clock_timestamp(), updated_at=clock_timestamp()
            WHERE name=$1`,
          [ACCOUNT_FENCE_MIGRATION],
        );
        return {
          phase: "complete",
          complete: true,
          processed_in_batch: 0,
          processed_count: processedCount,
        };
      }
    }
    return {
      phase: nextPhase,
      complete: false,
      processed_in_batch: batch.candidate_count,
      processed_count: processedCount,
    };
  }, db);
}

async function assertBillingAuthorityActivationComplete(
  db: Queryable,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1
       FROM billing_authority_migrations
      WHERE name=$1 AND complete AND phase='complete'
      FOR SHARE`,
    [ACCOUNT_FENCE_MIGRATION],
  );
  if (!rows[0]) {
    throw authorityError(
      "billing authority preactivation migration is incomplete",
      503,
    );
  }
}

export async function submitBillingAuthorityCommand(
  request: BillingAuthoritySubmitRequest,
): Promise<BillingAuthorityCommandRecord> {
  const { expiresAt, deduplicateForMs } = assertValidSubmission(request);
  const { hash, json } = requestHash(request);
  const operation = billingAuthorityOperationName(request.command);
  const lane = billingAuthorityLane(request.command);
  const accountIds = billingAuthorityAccountIds(request.command);
  if (accountIds.length > 32 || accountIds.some((id) => !isValidUUID(id))) {
    throw authorityError("invalid billing authority account attribution", 400);
  }
  const accountId = accountIds[0];
  const actorAccountId = billingAuthorityActorAccountId(request.command);
  if (actorAccountId && !isValidUUID(actorAccountId)) {
    throw authorityError("invalid billing authority actor account", 400);
  }
  const allowedWhenFrozen = new Set(
    billingAuthorityAccountsAllowedWhenFrozen(request.command),
  );
  return await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    const { rows: leaseRows } = await db.query<LeaseRow>(
      `SELECT holder_id, generation, lease_until, enabled, draining
         FROM billing_authority_lease
        WHERE name=$1
          AND enabled
          AND holder_id IS NOT NULL
          AND lease_until > clock_timestamp()
        FOR SHARE`,
      [LEASE_NAME],
    );
    if (!leaseRows[0] || leaseRows[0].draining) {
      throw authorityError("billing authority is not ready", 503);
    }
    const governedAccountIds = accountIds.filter(
      (id) => !allowedWhenFrozen.has(id),
    );
    await assertBillingAccountsAllowed(db, governedAccountIds);
    const existing = await existingCommand(db, request.command_id);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw authorityError(
          "billing authority command_id was reused with different input",
          409,
        );
      }
      if (
        (existing.status === "canceled" || existing.status === "expired") &&
        existing.attempt_count === 0
      ) {
        const { rows } = await db.query<CommandRow>(
          `UPDATE billing_authority_commands
              SET status=CASE WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                              THEN 'expired' ELSE 'queued' END,
                  expires_at=$2, started_at=NULL,
                  finished_at=CASE
                    WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                      THEN statement_timestamp()
                    ELSE NULL
                  END,
                  authority_generation=NULL, authority_instance_id=NULL,
                  operation=$3, lane=$4, account_id=$5,
                  account_ids=$6::UUID[], actor_account_id=$7,
                  command=$8::JSONB, result=NULL,
                  error=CASE
                    WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                      THEN jsonb_build_object(
                        'message', 'command expired before admission',
                        'code', 408, 'status', 408)
                    ELSE NULL
                  END,
                  updated_at=clock_timestamp()
            WHERE command_id=$1
              AND status IN ('canceled','expired')
              AND attempt_count=0
            RETURNING *`,
          [
            request.command_id,
            expiresAt.toISOString(),
            operation,
            lane,
            accountId ?? null,
            accountIds,
            actorAccountId ?? null,
            json,
          ],
        );
        if (rows[0]) return commandRecord(rows[0]);
      }
      if (
        (existing.status === "failed" || existing.status === "uncertain") &&
        (await canRecoverAdminPackage(db, existing, request.command))
      ) {
        const { rows } = await db.query<CommandRow>(
          `UPDATE billing_authority_commands
              SET status=CASE WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                              THEN CASE
                                WHEN provider_uncertain_started_at IS NOT NULL
                                  THEN 'uncertain'
                                ELSE 'expired'
                              END
                              ELSE 'queued' END,
                  expires_at=$2, started_at=NULL,
                  finished_at=CASE
                    WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                      THEN statement_timestamp()
                    ELSE NULL
                  END,
                  authority_generation=NULL, authority_instance_id=NULL,
                  operation=$3, lane=$4, account_id=$5,
                  account_ids=$6::UUID[], actor_account_id=$7,
                  command=$8::JSONB, result=NULL,
                  error=CASE
                    WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                         AND provider_uncertain_started_at IS NOT NULL
                      THEN COALESCE(
                        error,
                        jsonb_build_object(
                          'message', 'a prior Stripe mutation outcome remains unresolved',
                          'code', 'stripe_mutation_outcome_unresolved',
                          'status', 503))
                    WHEN $2::TIMESTAMPTZ <= statement_timestamp()
                      THEN jsonb_build_object(
                        'message', 'command expired before admission',
                        'code', 408, 'status', 408)
                    WHEN provider_uncertain_started_at IS NOT NULL
                      THEN error
                    ELSE NULL
                  END,
                  updated_at=clock_timestamp()
            WHERE command_id=$1 AND status IN ('failed','uncertain')
              AND attempt_count > 0 AND request_hash=$9
            RETURNING *`,
          [
            request.command_id,
            expiresAt.toISOString(),
            operation,
            lane,
            accountId ?? null,
            accountIds,
            actorAccountId ?? null,
            json,
            hash,
          ],
        );
        if (rows[0]) return commandRecord(rows[0]);
      }
      return commandRecord(existing, true);
    }
    if (deduplicateForMs > 0) {
      const { rows } = await db.query<CommandRow>(
        `SELECT * FROM billing_authority_commands
          WHERE request_hash=$1
            AND created_at >=
                clock_timestamp() - ($2::TEXT || ' milliseconds')::INTERVAL
            AND status IN ('queued', 'running')
          ORDER BY created_at DESC, command_id
          LIMIT 1`,
        [hash, deduplicateForMs],
      );
      if (rows[0]) return commandRecord(rows[0], true);
    }
    const { rows: counts } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM billing_authority_commands
        WHERE status='queued' AND lane=$1`,
      [lane],
    );
    if (Number(counts[0]?.count ?? 0) >= MAX_QUEUE_DEPTH[lane]) {
      throw authorityError(`billing authority ${lane} lane is full`, 503);
    }
    const { rows } = await db.query<CommandRow>(
      `INSERT INTO billing_authority_commands
         (command_id, request_hash, operation, lane, account_id, account_ids,
          actor_account_id, command,
          status, expires_at, created_at, updated_at, finished_at, error)
       VALUES ($1, $2, $3, $4, $5, $6::UUID[], $7, $8::JSONB,
               CASE WHEN $9::TIMESTAMPTZ <= statement_timestamp()
                    THEN 'expired' ELSE 'queued' END,
               $9, statement_timestamp(), statement_timestamp(),
               CASE WHEN $9::TIMESTAMPTZ <= statement_timestamp()
                    THEN statement_timestamp() ELSE NULL END,
               CASE WHEN $9::TIMESTAMPTZ <= statement_timestamp()
                    THEN jsonb_build_object(
                      'message', 'command expired before admission',
                      'code', 408, 'status', 408)
                    ELSE NULL END)
       RETURNING *`,
      [
        request.command_id,
        hash,
        operation,
        lane,
        accountId ?? null,
        accountIds,
        actorAccountId ?? null,
        json,
        expiresAt.toISOString(),
      ],
    );
    return commandRecord(rows[0]);
  });
}

export async function getBillingAuthorityCommand(
  commandId: string,
): Promise<BillingAuthorityCommandRecord | undefined> {
  if (!isValidUUID(commandId)) {
    throw authorityError("invalid billing authority command_id", 400);
  }
  const row = await existingCommand(getPool(), commandId);
  return row ? commandRecord(row) : undefined;
}

export async function cancelQueuedBillingAuthorityCommand(
  commandId: string,
): Promise<BillingAuthorityCommandRecord | undefined> {
  if (!isValidUUID(commandId)) {
    throw authorityError("invalid billing authority command_id", 400);
  }
  const { rows } = await getPool().query<CommandRow>(
    `UPDATE billing_authority_commands
        SET status=CASE
              WHEN provider_uncertain_started_at IS NOT NULL
                THEN 'uncertain'
              ELSE 'canceled'
            END,
            finished_at=clock_timestamp(),
            updated_at=clock_timestamp(),
            error=CASE
              WHEN provider_uncertain_started_at IS NOT NULL
                THEN COALESCE(
                  error,
                  jsonb_build_object(
                    'message', 'a prior Stripe mutation outcome remains unresolved',
                    'code', 'stripe_mutation_outcome_unresolved',
                    'status', 503))
              ELSE jsonb_build_object(
                'message', 'caller canceled queued command',
                'code', 408, 'status', 408)
            END
      WHERE command_id=$1 AND status='queued'
      RETURNING *`,
    [commandId],
  );
  const row = rows[0] ?? (await existingCommand(getPool(), commandId));
  return row ? commandRecord(row) : undefined;
}

export async function registerBillingAuthorityCommandAccount({
  ...identity
}: BillingAuthorityLeaseIdentity & {
  command_id: string;
  account_id: string;
}): Promise<void> {
  if (!isValidUUID(identity.account_id)) {
    throw authorityError("invalid dynamically resolved billing account", 400);
  }
  await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    await assertBillingAuthorityLease(identity, db);
    const { rows } = await db.query<CommandRow>(
      `SELECT * FROM billing_authority_commands
        WHERE command_id=$1 AND status='running'
          AND authority_instance_id=$2 AND authority_generation=$3
        FOR UPDATE`,
      [identity.command_id, identity.instance_id, identity.generation],
    );
    const command = rows[0];
    if (!command) {
      throw authorityError(
        "billing authority command is no longer active",
        503,
      );
    }
    const allowed = billingAuthorityAccountsAllowedWhenFrozen(command.command);
    if (!allowed.includes(identity.account_id)) {
      await assertBillingAccountsAllowed(db, [identity.account_id]);
    }
    await db.query(
      `UPDATE billing_authority_commands
          SET account_id=COALESCE(account_id, $2),
              account_ids=CASE WHEN $2=ANY(account_ids) THEN account_ids
                               ELSE array_append(account_ids, $2) END,
              updated_at=clock_timestamp()
        WHERE command_id=$1`,
      [identity.command_id, identity.account_id],
    );
  });
}

export async function setBillingAuthorityAccountFrozen({
  account_id,
  frozen,
  reason,
  actor_account_id,
  cause,
}: {
  account_id: string;
  frozen: boolean;
  reason: string;
  actor_account_id?: string;
  cause?: BillingAuthorityFenceCause;
}): Promise<{ account_id: string; frozen: boolean; generation: number }> {
  if (!isValidUUID(account_id)) {
    throw authorityError("invalid billing account_id", 400);
  }
  if (actor_account_id && !isValidUUID(actor_account_id)) {
    throw authorityError("invalid billing fence actor_account_id", 400);
  }
  const cleanedReason = `${reason ?? ""}`.trim().slice(0, MAX_REASON_LENGTH);
  if (!cleanedReason) {
    throw authorityError("billing fence reason is required", 400);
  }
  const fenceCause = cause ?? inferFenceCause(cleanedReason);
  return await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    await db.query(
      `UPDATE billing_authority_account_fences
          SET causes=jsonb_build_object(
            'legacy', jsonb_build_object(
              'reason', COALESCE(reason, 'pre-cause billing fence'),
              'actor_account_id', actor_account_id,
              'updated_at', updated_at))
        WHERE account_id=$1 AND frozen
          AND COALESCE(causes, '{}'::JSONB)='{}'::JSONB`,
      [account_id],
    );
    const { rows } = await db.query<{
      account_id: string;
      frozen: boolean;
      generation: number;
    }>(
      `INSERT INTO billing_authority_account_fences
         (account_id, frozen, reason, causes, actor_account_id, generation,
          created_at, updated_at)
       VALUES ($1, $2, $3::TEXT,
               CASE WHEN $2 THEN jsonb_build_object(
                 $5::TEXT, jsonb_build_object(
                   'reason', $3::TEXT, 'actor_account_id', $4::UUID,
                   'updated_at', clock_timestamp()))
               ELSE '{}'::JSONB END,
               $4::UUID, 1, clock_timestamp(), clock_timestamp())
       ON CONFLICT (account_id) DO UPDATE
         SET causes=CASE
               WHEN EXCLUDED.frozen THEN
                 COALESCE(billing_authority_account_fences.causes, '{}'::JSONB)
                   || EXCLUDED.causes
               ELSE COALESCE(billing_authority_account_fences.causes, '{}'::JSONB)
                   - $5::TEXT
             END,
             frozen=CASE
               WHEN EXCLUDED.frozen THEN TRUE
               ELSE (COALESCE(
                 billing_authority_account_fences.causes, '{}'::JSONB) - $5::TEXT)
                   <> '{}'::JSONB
             END,
             reason=EXCLUDED.reason,
             actor_account_id=EXCLUDED.actor_account_id,
             generation=billing_authority_account_fences.generation + 1,
             updated_at=clock_timestamp()
       RETURNING account_id, frozen, generation`,
      [account_id, frozen, cleanedReason, actor_account_id ?? null, fenceCause],
    );
    if (rows[0].frozen) {
      await db.query(
        `UPDATE billing_authority_commands
            SET status=CASE
                  WHEN provider_uncertain_started_at IS NOT NULL
                    THEN 'uncertain'
                  ELSE 'canceled'
                END,
                finished_at=clock_timestamp(),
                updated_at=clock_timestamp(),
                error=CASE
                  WHEN provider_uncertain_started_at IS NOT NULL
                    THEN COALESCE(
                      error,
                      jsonb_build_object(
                        'message', 'a prior Stripe mutation outcome remains unresolved',
                        'code', 'stripe_mutation_outcome_unresolved',
                        'status', 503))
                  ELSE jsonb_build_object(
                    'message', 'account billing was frozen before execution',
                    'code', 423, 'status', 423)
                END
          WHERE status='queued'
            AND (account_id=$1 OR $1=ANY(account_ids))`,
        [account_id],
      );
    }
    return rows[0];
  });
}

function inferFenceCause(reason: string): BillingAuthorityFenceCause {
  const value = reason.toLowerCase();
  if (value.includes("delet")) return "deletion";
  if (value.includes("ban")) return "ban";
  if (value.includes("quarant")) return "quarantine";
  if (value.includes("incident")) return "incident-response";
  return "operator";
}

export async function acquireBillingAuthorityLease({
  instance_id,
  lease_ms,
  db,
}: {
  instance_id: string;
  lease_ms: number;
  db?: Queryable;
}): Promise<{ generation: number; lease_until: string } | undefined> {
  if (!isValidUUID(instance_id))
    throw authorityError("invalid instance_id", 400);
  return await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [
      BILLING_AUTHORITY_EXECUTION_LOCK,
    ]);
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    await assertBillingAuthorityActivationComplete(db);
    await db.query(
      `INSERT INTO billing_authority_lease
         (name, generation, enabled, draining, updated_at)
       VALUES ($1, 0, TRUE, FALSE, clock_timestamp())
       ON CONFLICT (name) DO NOTHING`,
      [LEASE_NAME],
    );
    const { rows } = await db.query<LeaseRow>(
      `UPDATE billing_authority_lease
          SET holder_id=$2,
              generation=CASE WHEN holder_id=$2
                                    AND lease_until > clock_timestamp()
                                THEN generation
                              ELSE generation + 1 END,
              lease_until=clock_timestamp() + ($3::TEXT || ' milliseconds')::INTERVAL,
              draining=CASE WHEN holder_id=$2
                                  AND lease_until > clock_timestamp()
                              THEN draining ELSE FALSE END,
              serving=CASE WHEN holder_id=$2
                                 AND lease_until > clock_timestamp()
                            THEN serving ELSE FALSE END,
              handoff_exclude_holder_id=CASE
                WHEN handoff_exclude_holder_id IS NOT NULL
                     AND handoff_exclude_holder_id <> $2
                  THEN NULL
                ELSE handoff_exclude_holder_id
              END,
              updated_at=clock_timestamp()
        WHERE name=$1
          AND enabled
          AND (handoff_exclude_holder_id IS NULL
               OR handoff_exclude_holder_id <> $2)
          AND (holder_id=$2 OR holder_id IS NULL OR lease_until <= clock_timestamp())
        RETURNING holder_id, generation, lease_until, enabled, draining`,
      [LEASE_NAME, instance_id, lease_ms],
    );
    const lease = rows[0];
    if (!lease) return undefined;
    await db.query(
      `UPDATE billing_authority_commands
          SET status='uncertain', finished_at=clock_timestamp(),
              provider_uncertain_started_at=COALESCE(
                provider_uncertain_started_at, provider_attempt_started_at),
              updated_at=clock_timestamp(),
              error=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN COALESCE(
                    error,
                    jsonb_build_object(
                      'message', 'a prior Stripe mutation outcome remains unresolved',
                      'code', 'stripe_mutation_outcome_unresolved',
                      'status', 503))
                ELSE jsonb_build_object(
                  'message', 'authority changed while command outcome was unknown',
                  'code', 'authority_generation_changed', 'status', 503)
              END
        WHERE status='running'
          AND (authority_generation IS DISTINCT FROM $1
               OR authority_instance_id IS DISTINCT FROM $2)`,
      [lease.generation, instance_id],
    );
    return {
      generation: lease.generation,
      lease_until: iso(lease.lease_until)!,
    };
  }, db);
}

export async function markBillingAuthorityLeaseServing(
  identity: BillingAuthorityLeaseIdentity,
  db: Queryable = getPool(),
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE billing_authority_lease
        SET serving=TRUE, updated_at=clock_timestamp()
      WHERE name=$1 AND holder_id=$2 AND generation=$3
        AND enabled AND lease_until > clock_timestamp()`,
    [LEASE_NAME, identity.instance_id, identity.generation],
  );
  if (rowCount !== 1) {
    throw authorityError("billing authority lease was lost", 503);
  }
}

export async function renewBillingAuthorityLease({
  instance_id,
  generation,
  lease_ms,
  db = getPool(),
}: BillingAuthorityLeaseIdentity & {
  lease_ms: number;
  db?: Queryable;
}): Promise<{
  lease_until: string;
  enabled: boolean;
  draining: boolean;
}> {
  const { rows } = await db.query<LeaseRow>(
    `UPDATE billing_authority_lease
        SET lease_until=clock_timestamp() + ($4::TEXT || ' milliseconds')::INTERVAL,
            updated_at=clock_timestamp()
      WHERE name=$1 AND holder_id=$2 AND generation=$3
        AND lease_until > clock_timestamp()
      RETURNING lease_until, enabled, draining`,
    [LEASE_NAME, instance_id, generation, lease_ms],
  );
  if (!rows[0]) throw authorityError("billing authority lease was lost", 503);
  return {
    lease_until: iso(rows[0].lease_until)!,
    enabled: rows[0].enabled,
    draining: rows[0].draining,
  };
}

export async function assertBillingAuthorityLease(
  identity: BillingAuthorityLeaseIdentity,
  db: Queryable = getPool(),
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM billing_authority_lease
      WHERE name=$1 AND holder_id=$2 AND generation=$3
        AND lease_until > clock_timestamp()`,
    [LEASE_NAME, identity.instance_id, identity.generation],
  );
  if (!rows[0]) throw authorityError("billing authority lease was lost", 503);
}

export async function setBillingAuthorityDraining(
  identity: BillingAuthorityLeaseIdentity,
  db: Queryable = getPool(),
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE billing_authority_lease
        SET draining=TRUE, updated_at=clock_timestamp()
      WHERE name=$1 AND holder_id=$2 AND generation=$3
        AND lease_until > clock_timestamp()`,
    [LEASE_NAME, identity.instance_id, identity.generation],
  );
  if (rowCount !== 1)
    throw authorityError("billing authority lease was lost", 503);
}

export async function resumeBillingAuthorityLease(
  identity: BillingAuthorityLeaseIdentity,
): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE billing_authority_lease
        SET draining=FALSE, updated_at=clock_timestamp()
      WHERE name=$1 AND holder_id=$2 AND generation=$3
        AND lease_until > clock_timestamp()`,
    [LEASE_NAME, identity.instance_id, identity.generation],
  );
  if (rowCount !== 1)
    throw authorityError("billing authority lease was lost", 503);
}

export async function requestBillingAuthorityDrain({
  exclude_holder_id,
}: { exclude_holder_id?: string } = {}): Promise<void> {
  if (exclude_holder_id && !isValidUUID(exclude_holder_id)) {
    throw authorityError("invalid handoff excluded holder", 400);
  }
  await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    await db.query(
      `INSERT INTO billing_authority_lease
         (name, generation, enabled, draining, updated_at)
       VALUES ($1, 0, FALSE, FALSE, clock_timestamp())
       ON CONFLICT (name) DO UPDATE
         SET enabled=FALSE,
             draining=(billing_authority_lease.holder_id IS NOT NULL
                       AND billing_authority_lease.lease_until > clock_timestamp()),
             holder_id=CASE
               WHEN billing_authority_lease.lease_until > clock_timestamp()
                 THEN billing_authority_lease.holder_id
               ELSE NULL
             END,
             lease_until=CASE
               WHEN billing_authority_lease.lease_until > clock_timestamp()
                 THEN billing_authority_lease.lease_until
               ELSE NULL
             END,
             serving=(billing_authority_lease.serving
                      AND billing_authority_lease.lease_until > clock_timestamp()),
             handoff_exclude_holder_id=$2,
             updated_at=clock_timestamp()`,
      [LEASE_NAME, exclude_holder_id ?? null],
    );
    await db.query(
      `UPDATE billing_authority_commands
          SET status=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN 'uncertain'
                ELSE 'canceled'
              END,
              finished_at=clock_timestamp(),
              updated_at=clock_timestamp(),
              error=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN COALESCE(
                    error,
                    jsonb_build_object(
                      'message', 'a prior Stripe mutation outcome remains unresolved',
                      'code', 'stripe_mutation_outcome_unresolved',
                      'status', 503))
                ELSE jsonb_build_object(
                  'message', 'authority globally drained before execution',
                  'code', 503, 'status', 503)
              END
        WHERE status='queued'`,
    );
  });
}

export async function reconcileExpiredBillingAuthorityLease(): Promise<boolean> {
  return await withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [
      BILLING_AUTHORITY_EXECUTION_LOCK,
    ]);
    const { rows } = await db.query<LeaseRow>(
      `SELECT holder_id, generation, lease_until, enabled, draining,
              (holder_id IS NOT NULL
               AND lease_until > clock_timestamp()) AS lease_valid
         FROM billing_authority_lease
        WHERE name=$1
        FOR UPDATE`,
      [LEASE_NAME],
    );
    const lease = rows[0];
    if (!lease || lease.lease_valid) return false;
    const uncertain = await db.query(
      `UPDATE billing_authority_commands
          SET status='uncertain', finished_at=clock_timestamp(),
              provider_uncertain_started_at=COALESCE(
                provider_uncertain_started_at, provider_attempt_started_at),
              updated_at=clock_timestamp(),
              error=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN COALESCE(
                    error,
                    jsonb_build_object(
                      'message', 'a prior Stripe mutation outcome remains unresolved',
                      'code', 'stripe_mutation_outcome_unresolved',
                      'status', 503))
                ELSE jsonb_build_object(
                  'message', 'authority lease expired while globally drained',
                  'code', 'authority_lease_expired_during_drain', 'status', 503)
              END
        WHERE status='running'`,
    );
    const released = await db.query(
      `UPDATE billing_authority_lease
        SET holder_id=NULL, lease_until=NULL, draining=FALSE, serving=FALSE,
              updated_at=clock_timestamp()
        WHERE name=$1 AND holder_id IS NOT NULL`,
      [LEASE_NAME],
    );
    return (uncertain.rowCount ?? 0) > 0 || (released.rowCount ?? 0) > 0;
  });
}

export async function resumeBillingAuthorityGlobally(): Promise<void> {
  await getPool().query(
    `INSERT INTO billing_authority_lease
       (name, generation, enabled, draining, updated_at)
     VALUES ($1, 0, TRUE, FALSE, clock_timestamp())
     ON CONFLICT (name) DO UPDATE
       SET enabled=TRUE, draining=FALSE, updated_at=clock_timestamp()`,
    [LEASE_NAME],
  );
}

export async function releaseBillingAuthorityLease(
  identity: BillingAuthorityLeaseIdentity,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE billing_authority_lease
        SET holder_id=NULL, lease_until=NULL, draining=FALSE, serving=FALSE,
            updated_at=clock_timestamp()
      WHERE name=$1 AND holder_id=$2 AND generation=$3`,
    [LEASE_NAME, identity.instance_id, identity.generation],
  );
}

export async function beginBillingAuthorityCommandExecution({
  identity,
  db,
}: {
  identity: BillingAuthorityLeaseIdentity;
  db: Queryable;
}): Promise<void> {
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock($1)", [
      BILLING_AUTHORITY_EXECUTION_LOCK,
    ]);
    await assertBillingAuthorityLease(identity, db);
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

export async function recordBillingAuthorityProviderMutationStart({
  ...identity
}: BillingAuthorityLeaseIdentity & { command_id: string }): Promise<void> {
  // This must commit before network I/O. If the worker dies after Stripe sees
  // the request, lease recovery can preserve this attempt's replay anchor.
  const { rowCount } = await getPool().query(
    `UPDATE billing_authority_commands
        SET provider_attempt_started_at=COALESCE(
              provider_attempt_started_at, clock_timestamp()),
            updated_at=clock_timestamp()
      WHERE command_id=$1 AND status='running'
        AND authority_instance_id=$2 AND authority_generation=$3
        AND EXISTS (
          SELECT 1 FROM billing_authority_lease
           WHERE name=$4 AND holder_id=$2 AND generation=$3
             AND lease_until > clock_timestamp()
        )`,
    [
      identity.command_id,
      identity.instance_id,
      identity.generation,
      LEASE_NAME,
    ],
  );
  if (rowCount !== 1) {
    throw authorityError(
      "provider mutation start was fenced by authority loss",
      503,
    );
  }
}

export async function claimNextBillingAuthorityCommand(
  identity: BillingAuthorityLeaseIdentity,
  db?: Queryable,
): Promise<
  | { record: BillingAuthorityCommandRecord; command: BillingAuthorityCommand }
  | undefined
> {
  return await withTransaction(async (db) => {
    // Establish a total order with account freezes and global drains. Without
    // this lock, a claim could authorize queued work while an earlier freeze
    // transaction was still installing its fence.
    await db.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    const { rows: leaseRows } = await db.query<LeaseRow>(
      `SELECT holder_id, generation, lease_until, enabled, draining
         FROM billing_authority_lease
        WHERE name=$1 AND holder_id=$2 AND generation=$3
          AND lease_until > clock_timestamp()
        FOR SHARE`,
      [LEASE_NAME, identity.instance_id, identity.generation],
    );
    if (!leaseRows[0] || !leaseRows[0].enabled || leaseRows[0].draining) {
      return undefined;
    }
    await db.query(
      `UPDATE billing_authority_commands
          SET status=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN 'uncertain'
                ELSE 'expired'
              END,
              finished_at=clock_timestamp(),
              updated_at=clock_timestamp(),
              error=CASE
                WHEN provider_uncertain_started_at IS NOT NULL
                  THEN COALESCE(
                    error,
                    jsonb_build_object(
                      'message', 'a prior Stripe mutation outcome remains unresolved',
                      'code', 'stripe_mutation_outcome_unresolved',
                      'status', 503))
                ELSE jsonb_build_object(
                  'message', 'command expired before execution',
                  'code', 408, 'status', 408)
              END
        WHERE status='queued' AND expires_at <= clock_timestamp()`,
    );
    for (let skipped = 0; skipped < 8; skipped += 1) {
      const { rows } = await db.query<CommandRow>(
        `SELECT * FROM billing_authority_commands
          WHERE status='queued' AND expires_at > clock_timestamp()
          ORDER BY CASE lane WHEN 'critical' THEN 0
                             WHEN 'interactive' THEN 1 ELSE 2 END,
                   created_at, command_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return undefined;
      const governedAccountIds = (row.account_ids ?? [row.account_id])
        .filter((id): id is string => !!id)
        .filter(
          (id) =>
            !billingAuthorityAccountsAllowedWhenFrozen(row.command).includes(
              id,
            ),
        );
      try {
        await assertBillingAccountsAllowed(db, governedAccountIds);
      } catch (err) {
        if ((err as { status?: number })?.status !== 423) throw err;
        await db.query(
          `UPDATE billing_authority_commands
              SET status=CASE
                    WHEN provider_uncertain_started_at IS NOT NULL
                      THEN 'uncertain'
                    ELSE 'canceled'
                  END,
                  finished_at=clock_timestamp(),
                  updated_at=clock_timestamp(),
                  error=CASE
                    WHEN provider_uncertain_started_at IS NOT NULL
                      THEN COALESCE(
                        error,
                        jsonb_build_object(
                          'message', 'a prior Stripe mutation outcome remains unresolved',
                          'code', 'stripe_mutation_outcome_unresolved',
                          'status', 503))
                    ELSE jsonb_build_object(
                      'message', 'account billing is frozen',
                      'code', 423, 'status', 423)
                  END
            WHERE command_id=$1 AND status='queued'`,
          [row.command_id],
        );
        continue;
      }
      const { rows: claimed } = await db.query<CommandRow>(
        `UPDATE billing_authority_commands
            SET status='running', attempt_count=attempt_count + 1,
                authority_generation=$2, authority_instance_id=$3,
                first_started_at=COALESCE(first_started_at, clock_timestamp()),
                provider_attempt_started_at=NULL,
                started_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE command_id=$1 AND status='queued'
            AND expires_at > clock_timestamp()
          RETURNING *`,
        [row.command_id, identity.generation, identity.instance_id],
      );
      if (claimed[0]) {
        return {
          record: commandRecord(claimed[0]),
          command: claimed[0].command,
        };
      }
    }
    return undefined;
  }, db);
}

export async function finishBillingAuthorityCommand({
  db = getPool(),
  ...identity
}: BillingAuthorityLeaseIdentity & {
  command_id: string;
  result?: unknown;
  error?: BillingAuthorityError;
  status?: "succeeded" | "failed" | "uncertain";
  db?: Queryable;
}): Promise<void> {
  const status =
    identity.status ?? (identity.error == null ? "succeeded" : "failed");
  const succeeded = status === "succeeded";
  const terminalError = succeeded
    ? undefined
    : boundedTerminalError(identity.error, status);
  // Once a provider outcome is unresolved, only successful reconciliation can
  // make it definitive. A later failure may concern a different Stripe step.
  const { rowCount } = await db.query(
    `UPDATE billing_authority_commands
        SET status=CASE
              WHEN $4::TEXT <> 'succeeded'
                   AND provider_uncertain_started_at IS NOT NULL
                THEN 'uncertain'
              ELSE $4::TEXT
            END,
            result=$5::JSONB,
            error=CASE
              WHEN $4::TEXT='succeeded' THEN NULL
              WHEN provider_uncertain_started_at IS NOT NULL
                THEN COALESCE(
                  error,
                  jsonb_build_object(
                    'message', 'a prior Stripe mutation outcome remains unresolved',
                    'code', 'stripe_mutation_outcome_unresolved',
                    'status', 503))
              ELSE $6::JSONB
            END,
            provider_uncertain_started_at=CASE WHEN $4::TEXT='uncertain'
              THEN COALESCE(provider_uncertain_started_at,
                            provider_attempt_started_at)
              ELSE provider_uncertain_started_at END,
            finished_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE command_id=$1 AND status='running'
        AND authority_instance_id=$2 AND authority_generation=$3
        AND EXISTS (
          SELECT 1 FROM billing_authority_lease
           WHERE name=$7 AND holder_id=$2 AND generation=$3
             AND lease_until > clock_timestamp()
        )`,
    [
      identity.command_id,
      identity.instance_id,
      identity.generation,
      status,
      succeeded ? JSON.stringify(identity.result ?? null) : null,
      succeeded ? null : JSON.stringify(terminalError),
      LEASE_NAME,
    ],
  );
  if (rowCount !== 1) {
    throw authorityError("command completion was fenced by lease loss", 503);
  }
}

export async function getBillingAuthorityHealth(): Promise<BillingAuthorityHealth> {
  const [
    { rows: leases },
    { rows: queues },
    { rows: terminals },
    { rows: running },
  ] = await Promise.all([
    getPool().query<LeaseRow>(
      `SELECT holder_id, generation, lease_until, enabled, draining, serving,
                (holder_id IS NOT NULL
                 AND lease_until > clock_timestamp()) AS lease_valid
           FROM billing_authority_lease WHERE name=$1`,
      [LEASE_NAME],
    ),
    getPool().query<{ lane: BillingAuthorityLane; count: string }>(
      `SELECT lane, COUNT(*)::TEXT AS count
           FROM billing_authority_commands WHERE status='queued'
          GROUP BY lane`,
    ),
    getPool().query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::TEXT AS count
           FROM billing_authority_commands
          WHERE finished_at >= clock_timestamp() - INTERVAL '24 hours'
            AND status IN ('succeeded','failed','uncertain')
          GROUP BY status`,
    ),
    getPool().query<{ command_id: string }>(
      `SELECT command_id
           FROM billing_authority_commands
          WHERE status='running'
          ORDER BY started_at, command_id
          LIMIT 1`,
    ),
  ]);
  const lease = leases[0];
  const queue_depth: BillingAuthorityHealth["queue_depth"] = {
    critical: 0,
    interactive: 0,
    maintenance: 0,
  };
  for (const row of queues) queue_depth[row.lane] = Number(row.count);
  const terminal = Object.fromEntries(
    terminals.map(({ status, count }) => [status, Number(count)]),
  );
  const enabled = lease?.enabled ?? true;
  const serving = !!lease?.lease_valid && lease.serving === true;
  const ready = serving && enabled && !lease.draining;
  return {
    ...(serving && lease?.holder_id ? { instance_id: lease.holder_id } : {}),
    ...(lease ? { generation: lease.generation } : {}),
    ...(iso(lease?.lease_until)
      ? { lease_until: iso(lease?.lease_until) }
      : {}),
    ready,
    enabled,
    draining: !enabled || (lease?.draining ?? false),
    ...(serving && running[0]?.command_id
      ? { active_command_id: running[0].command_id }
      : {}),
    queue_depth,
    completed: terminal.succeeded ?? 0,
    failed: (terminal.failed ?? 0) + (terminal.uncertain ?? 0),
  };
}

export async function pruneBillingAuthorityCommands(): Promise<number> {
  return await withTransaction(async (db) => {
    await db.query(
      `UPDATE billing_authority_commands
          SET command=jsonb_build_object('redacted', TRUE),
              status=CASE
                WHEN status='succeeded'
                     AND operation <> 'stripe-webhook'
                     AND result IS NOT NULL
                  THEN 'expired'
                ELSE status
              END,
              result=CASE WHEN operation='stripe-webhook'
                          THEN result ELSE NULL END,
              error=CASE
                WHEN status='succeeded'
                     AND operation <> 'stripe-webhook'
                     AND result IS NOT NULL
                  THEN jsonb_build_object(
                    'message', 'successful command result expired; reconcile by command identity',
                    'code', 'billing_authority_result_expired',
                    'status', 410)
                ELSE error
              END,
              updated_at=clock_timestamp()
        WHERE finished_at < clock_timestamp() - $1::INTERVAL
          AND (command IS DISTINCT FROM jsonb_build_object('redacted', TRUE)
               OR (operation <> 'stripe-webhook' AND result IS NOT NULL))
          AND status IN ('succeeded','failed','canceled','expired','uncertain')`,
      [PAYLOAD_RETENTION],
    );
    const { rowCount } = await db.query(
      `DELETE FROM billing_authority_commands
        WHERE finished_at < clock_timestamp() - $1::INTERVAL`,
      [AUDIT_RETENTION],
    );
    return rowCount ?? 0;
  });
}
