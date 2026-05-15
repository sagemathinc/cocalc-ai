/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";

type Queryable = Pick<PoolClient, "query">;

export type ProjectRuntimeSlotState =
  | "starting"
  | "running"
  | "released"
  | "expired"
  | "failed";

export interface ProjectRuntimeSlot {
  sponsor_account_id: string;
  project_id: string;
  owning_bay_id: string;
  host_id?: string | null;
  state: ProjectRuntimeSlotState;
  actor_account_id?: string | null;
  reason?: string | null;
  acquired_at: Date | string;
  heartbeat_at: Date | string;
  expires_at: Date | string;
  op_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RuntimeSponsorSlotDenial {
  code: "runtime_sponsor_slots_exhausted";
  sponsor_account_id: string;
  limit: number;
  current: number;
  active_projects: ProjectRuntimeSlot[];
}

export class RuntimeSponsorSlotsExhaustedError extends Error {
  public readonly denial: RuntimeSponsorSlotDenial;

  constructor(denial: RuntimeSponsorSlotDenial) {
    super(
      `runtime sponsor ${denial.sponsor_account_id} is using ${denial.current}/${denial.limit} running-project slots`,
    );
    this.name = "RuntimeSponsorSlotsExhaustedError";
    this.denial = denial;
  }
}

export interface ReserveProjectRuntimeSlotOptions {
  sponsor_account_id: string;
  project_id: string;
  owning_bay_id: string;
  host_id?: string | null;
  actor_account_id?: string | null;
  reason?: string | null;
  op_id?: string | null;
  state?: Extract<ProjectRuntimeSlotState, "starting" | "running">;
  ttl_ms?: number;
  metadata?: Record<string, unknown>;
  client?: PoolClient;
}

export interface ReserveProjectRuntimeSlotResult {
  sponsor_account_id: string;
  project_id: string;
  limit?: number;
  current: number;
  slot: ProjectRuntimeSlot;
}

const ACTIVE_SLOT_STATES = ["starting", "running"] as const;
const DEFAULT_RUNTIME_SLOT_TTL_MS = 15 * 60 * 1000;

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function expirationDate(ttl_ms: number | undefined): Date {
  return new Date(Date.now() + (ttl_ms ?? DEFAULT_RUNTIME_SLOT_TTL_MS));
}

async function expireStaleRuntimeSlots(client: Queryable): Promise<void> {
  await client.query(
    `
      UPDATE project_runtime_slots
         SET state='expired',
             metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('expired_by', 'runtime-slot-admission')
       WHERE state = ANY($1)
         AND expires_at < NOW()
    `,
    [ACTIVE_SLOT_STATES],
  );
}

async function loadActiveSlotsForSponsor(
  client: Queryable,
  sponsor_account_id: string,
): Promise<ProjectRuntimeSlot[]> {
  const { rows } = await client.query<ProjectRuntimeSlot>(
    `
      SELECT sponsor_account_id, project_id, owning_bay_id, host_id, state,
             actor_account_id, reason, acquired_at, heartbeat_at, expires_at,
             op_id, metadata
        FROM project_runtime_slots
       WHERE sponsor_account_id=$1
         AND state = ANY($2)
       ORDER BY heartbeat_at DESC, acquired_at DESC
    `,
    [sponsor_account_id, ACTIVE_SLOT_STATES],
  );
  return rows;
}

async function reserveProjectRuntimeSlotInTransaction(
  client: PoolClient,
  opts: ReserveProjectRuntimeSlotOptions,
): Promise<ReserveProjectRuntimeSlotResult> {
  await expireStaleRuntimeSlots(client);
  const activeSlots = await loadActiveSlotsForSponsor(
    client,
    opts.sponsor_account_id,
  );
  const existingSlot = activeSlots.find(
    (slot) => slot.project_id === opts.project_id,
  );
  const current = existingSlot ? activeSlots.length : activeSlots.length + 1;
  const membership = await resolveMembershipForAccount(opts.sponsor_account_id);
  const limit = normalizePositiveInteger(
    getEffectiveMembershipUsageLimits(membership)
      .max_sponsored_running_projects,
  );

  if (!existingSlot && limit != null && activeSlots.length >= limit) {
    throw new RuntimeSponsorSlotsExhaustedError({
      code: "runtime_sponsor_slots_exhausted",
      sponsor_account_id: opts.sponsor_account_id,
      limit,
      current: activeSlots.length,
      active_projects: activeSlots,
    });
  }

  const { rows } = await client.query<ProjectRuntimeSlot>(
    `
      INSERT INTO project_runtime_slots
        (sponsor_account_id, project_id, owning_bay_id, host_id, state,
         actor_account_id, reason, acquired_at, heartbeat_at, expires_at,
         op_id, metadata)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8, $9, $10)
      ON CONFLICT (sponsor_account_id, project_id)
      DO UPDATE SET
        owning_bay_id=EXCLUDED.owning_bay_id,
        host_id=EXCLUDED.host_id,
        state=EXCLUDED.state,
        actor_account_id=EXCLUDED.actor_account_id,
        reason=EXCLUDED.reason,
        heartbeat_at=NOW(),
        expires_at=EXCLUDED.expires_at,
        op_id=EXCLUDED.op_id,
        metadata=EXCLUDED.metadata
      RETURNING sponsor_account_id, project_id, owning_bay_id, host_id, state,
                actor_account_id, reason, acquired_at, heartbeat_at,
                expires_at, op_id, metadata
    `,
    [
      opts.sponsor_account_id,
      opts.project_id,
      opts.owning_bay_id,
      opts.host_id ?? null,
      opts.state ?? "starting",
      opts.actor_account_id ?? null,
      opts.reason ?? null,
      expirationDate(opts.ttl_ms),
      opts.op_id ?? null,
      opts.metadata ?? {},
    ],
  );
  return {
    sponsor_account_id: opts.sponsor_account_id,
    project_id: opts.project_id,
    limit,
    current,
    slot: rows[0],
  };
}

export async function reserveProjectRuntimeSlotLocal(
  opts: ReserveProjectRuntimeSlotOptions,
): Promise<ReserveProjectRuntimeSlotResult> {
  const pool = opts.client ?? getPool();
  const client =
    "release" in pool ? (pool as PoolClient) : await getPool().connect();
  const release = "release" in pool ? undefined : () => client.release();
  try {
    await client.query("BEGIN");
    try {
      const result = await reserveProjectRuntimeSlotInTransaction(client, opts);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    release?.();
  }
}

export async function heartbeatProjectRuntimeSlotLocal({
  sponsor_account_id,
  project_id,
  state = "running",
  host_id,
  ttl_ms,
  metadata,
  client,
}: {
  sponsor_account_id: string;
  project_id: string;
  state?: Extract<ProjectRuntimeSlotState, "starting" | "running">;
  host_id?: string | null;
  ttl_ms?: number;
  metadata?: Record<string, unknown>;
  client?: PoolClient;
}): Promise<boolean> {
  const pool = client ?? getPool();
  const { rowCount } = await pool.query(
    `
      UPDATE project_runtime_slots
         SET state=$3,
             host_id=COALESCE($4, host_id),
             heartbeat_at=NOW(),
             expires_at=$5,
             metadata=COALESCE($6, metadata, '{}'::jsonb)
       WHERE sponsor_account_id=$1
         AND project_id=$2
         AND state = ANY($7)
    `,
    [
      sponsor_account_id,
      project_id,
      state,
      host_id ?? null,
      expirationDate(ttl_ms),
      metadata ?? null,
      ACTIVE_SLOT_STATES,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseProjectRuntimeSlotLocal({
  sponsor_account_id,
  project_id,
  state = "released",
  client,
}: {
  sponsor_account_id: string;
  project_id: string;
  state?: Extract<ProjectRuntimeSlotState, "released" | "failed">;
  client?: PoolClient;
}): Promise<boolean> {
  const pool = client ?? getPool();
  const { rowCount } = await pool.query(
    `
      UPDATE project_runtime_slots
         SET state=$3,
             heartbeat_at=NOW(),
             expires_at=NOW()
       WHERE sponsor_account_id=$1
         AND project_id=$2
         AND state = ANY($4)
    `,
    [sponsor_account_id, project_id, state, ACTIVE_SLOT_STATES],
  );
  return (rowCount ?? 0) > 0;
}

export async function listProjectRuntimeSlotsLocal({
  sponsor_account_id,
  active_only = true,
  client,
}: {
  sponsor_account_id: string;
  active_only?: boolean;
  client?: PoolClient;
}): Promise<ProjectRuntimeSlot[]> {
  const pool = client ?? getPool();
  if (active_only) {
    await expireStaleRuntimeSlots(pool);
    return await loadActiveSlotsForSponsor(pool, sponsor_account_id);
  }
  const { rows } = await pool.query<ProjectRuntimeSlot>(
    `
      SELECT sponsor_account_id, project_id, owning_bay_id, host_id, state,
             actor_account_id, reason, acquired_at, heartbeat_at, expires_at,
             op_id, metadata
        FROM project_runtime_slots
       WHERE sponsor_account_id=$1
       ORDER BY heartbeat_at DESC, acquired_at DESC
    `,
    [sponsor_account_id],
  );
  return rows;
}
