/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
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
import {
  billingAuthorityAccountIds,
  billingAuthorityAccountsAllowedWhenFrozen,
  billingAuthorityActorAccountId,
  billingAuthorityLane,
  billingAuthorityOperationName,
} from "./protocol";

const LEASE_NAME = "primary";
const ADMISSION_LOCK = 1_111_575_378;
export const BILLING_AUTHORITY_EXECUTION_LOCK = 1_111_575_379;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_REASON_LENGTH = 4000;
const MAX_DEDUPLICATION_MS = 24 * 60 * 60_000;
const PAYLOAD_RETENTION = "48 hours";
const AUDIT_RETENTION = "400 days";
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
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
  expires_at: Date | string;
  authority_generation?: number | null;
  attempt_count: number;
}

function authorityError(message: string, status: number): Error {
  return Object.assign(new Error(message), { code: status, status });
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return canonical(toJSON.call(value));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function requestJson(request: BillingAuthoritySubmitRequest): string {
  return JSON.stringify(canonical(request.command));
}

function requestHash(request: BillingAuthoritySubmitRequest): {
  hash: string;
  json: string;
} {
  const json = requestJson(request);
  if (Buffer.byteLength(json) > MAX_COMMAND_BYTES) {
    throw authorityError("billing authority command is too large", 413);
  }
  return {
    hash: createHash("sha256").update(json).digest("hex"),
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

export async function submitBillingAuthorityCommand(
  request: BillingAuthoritySubmitRequest,
): Promise<BillingAuthorityCommandRecord> {
  const { expiresAt, deduplicateForMs } = assertValidSubmission(request);
  const { hash } = requestHash(request);
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
    if (governedAccountIds.length > 0) {
      const { rows } = await db.query<{ account_id: string }>(
        `SELECT account_id
           FROM billing_authority_account_fences
          WHERE account_id=ANY($1::UUID[]) AND frozen
          LIMIT 1`,
        [governedAccountIds],
      );
      if (rows[0]) {
        throw authorityError("billing is frozen for this account", 423);
      }
    }
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
              SET status=CASE WHEN $2::TIMESTAMPTZ <= clock_timestamp()
                              THEN 'expired' ELSE 'queued' END,
                  expires_at=$2, started_at=NULL, finished_at=NULL,
                  authority_generation=NULL, authority_instance_id=NULL,
                  result=NULL, error=NULL, updated_at=clock_timestamp()
            WHERE command_id=$1
              AND status IN ('canceled','expired')
              AND attempt_count=0
            RETURNING *`,
          [request.command_id, expiresAt.toISOString()],
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
          status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::UUID[], $7, $8::JSONB,
               CASE WHEN $9::TIMESTAMPTZ <= clock_timestamp()
                    THEN 'expired' ELSE 'queued' END,
               $9, clock_timestamp(), clock_timestamp())
       RETURNING *`,
      [
        request.command_id,
        hash,
        operation,
        lane,
        accountId ?? null,
        accountIds,
        actorAccountId ?? null,
        JSON.stringify(request.command),
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
        SET status='canceled', finished_at=clock_timestamp(),
            updated_at=clock_timestamp(),
            error=jsonb_build_object('message', 'caller canceled queued command',
                                     'code', 408, 'status', 408)
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
      const { rows: fences } = await db.query(
        `SELECT 1 FROM billing_authority_account_fences
          WHERE account_id=$1 AND frozen`,
        [identity.account_id],
      );
      if (fences[0]) {
        throw authorityError("billing is frozen for this account", 423);
      }
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
            SET status='canceled', finished_at=clock_timestamp(),
                updated_at=clock_timestamp(),
                error=jsonb_build_object(
                  'message', 'account billing was frozen before execution',
                  'code', 423, 'status', 423)
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
              updated_at=clock_timestamp(),
              error=jsonb_build_object(
                'message', 'authority changed while command outcome was unknown',
                'code', 'authority_generation_changed', 'status', 503)
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
          SET status='canceled', finished_at=clock_timestamp(),
              updated_at=clock_timestamp(),
              error=jsonb_build_object(
                'message', 'authority globally drained before execution',
                'code', 503, 'status', 503)
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
              updated_at=clock_timestamp(),
              error=jsonb_build_object(
                'message', 'authority lease expired while globally drained',
                'code', 'authority_lease_expired_during_drain', 'status', 503)
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

export async function claimNextBillingAuthorityCommand(
  identity: BillingAuthorityLeaseIdentity,
): Promise<
  | { record: BillingAuthorityCommandRecord; command: BillingAuthorityCommand }
  | undefined
> {
  return await withTransaction(async (db) => {
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
          SET status='expired', finished_at=clock_timestamp(),
              updated_at=clock_timestamp(),
              error=jsonb_build_object('message', 'command expired before execution',
                                       'code', 408, 'status', 408)
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
      if (governedAccountIds.length > 0) {
        const { rows: fences } = await db.query<{ account_id: string }>(
          `SELECT account_id FROM billing_authority_account_fences
            WHERE account_id=ANY($1::UUID[]) AND frozen
            LIMIT 1`,
          [governedAccountIds],
        );
        if (fences[0]) {
          await db.query(
            `UPDATE billing_authority_commands
                SET status='canceled', finished_at=clock_timestamp(),
                    updated_at=clock_timestamp(),
                    error=jsonb_build_object(
                      'message', 'account billing is frozen',
                      'code', 423, 'status', 423)
              WHERE command_id=$1 AND status='queued'`,
            [row.command_id],
          );
          continue;
        }
      }
      const { rows: claimed } = await db.query<CommandRow>(
        `UPDATE billing_authority_commands
            SET status='running', attempt_count=attempt_count + 1,
                authority_generation=$2, authority_instance_id=$3,
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
  });
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
  const { rowCount } = await db.query(
    `UPDATE billing_authority_commands
        SET status=$4, result=$5::JSONB, error=$6::JSONB,
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
      succeeded ? null : JSON.stringify(identity.error),
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
              result=CASE WHEN operation='stripe-webhook'
                          THEN result ELSE NULL END
        WHERE finished_at < clock_timestamp() - $1::INTERVAL
          AND (command IS DISTINCT FROM jsonb_build_object('redacted', TRUE)
               OR result IS NOT NULL)
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
