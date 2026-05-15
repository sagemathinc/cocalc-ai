/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";

type Queryable = Pick<PoolClient, "query">;
const logger = getLogger("projects:runtime-slots");

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
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const HEARTBEAT_TTL_MS = 30 * 60 * 1000;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

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

async function runtimeSponsorHomeBay(
  sponsor_account_id: string,
): Promise<string> {
  const location = await resolveAccountHomeBay({
    account_id: sponsor_account_id,
    user_account_id: sponsor_account_id,
  });
  return `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

function accountLocalClient(dest_bay: string) {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
  });
}

export async function reserveProjectRuntimeSlot(
  opts: ReserveProjectRuntimeSlotOptions,
): Promise<ReserveProjectRuntimeSlotResult> {
  const homeBay = await runtimeSponsorHomeBay(opts.sponsor_account_id);
  if (homeBay === getConfiguredBayId()) {
    return await reserveProjectRuntimeSlotLocal(opts);
  }
  return await accountLocalClient(homeBay).reserveProjectRuntimeSlot(opts);
}

export async function heartbeatProjectRuntimeSlot(
  opts: Parameters<typeof heartbeatProjectRuntimeSlotLocal>[0],
): Promise<boolean> {
  const homeBay = await runtimeSponsorHomeBay(opts.sponsor_account_id);
  if (homeBay === getConfiguredBayId()) {
    return await heartbeatProjectRuntimeSlotLocal(opts);
  }
  return await accountLocalClient(homeBay).heartbeatProjectRuntimeSlot(opts);
}

export async function releaseProjectRuntimeSlot(
  opts: Parameters<typeof releaseProjectRuntimeSlotLocal>[0],
): Promise<boolean> {
  const homeBay = await runtimeSponsorHomeBay(opts.sponsor_account_id);
  if (homeBay === getConfiguredBayId()) {
    return await releaseProjectRuntimeSlotLocal(opts);
  }
  return await accountLocalClient(homeBay).releaseProjectRuntimeSlot(opts);
}

export async function listProjectRuntimeSlots(
  opts: Parameters<typeof listProjectRuntimeSlotsLocal>[0],
): Promise<ProjectRuntimeSlot[]> {
  const homeBay = await runtimeSponsorHomeBay(opts.sponsor_account_id);
  if (homeBay === getConfiguredBayId()) {
    return await listProjectRuntimeSlotsLocal(opts);
  }
  return await accountLocalClient(homeBay).listProjectRuntimeSlots(opts);
}

export async function heartbeatActiveProjectRuntimeSlotsOnOwningBay(): Promise<{
  heartbeated: number;
  missing_sponsor: number;
  failed: number;
}> {
  const { rows } = await getPool().query<{
    project_id: string;
    runtime_sponsor_account_id?: string | null;
    usage_account_id?: string | null;
    users?: Record<string, { group?: string }> | null;
    owning_bay_id?: string | null;
    host_id?: string | null;
    state?: { state?: string } | null;
  }>(
    `
      SELECT project_id, runtime_sponsor_account_id, usage_account_id, users,
             owning_bay_id, host_id, state
        FROM projects
       WHERE COALESCE(state->>'state', '') = ANY($1)
         AND COALESCE(deleted, false) IS NOT TRUE
    `,
    [ACTIVE_SLOT_STATES],
  );
  let heartbeated = 0;
  let missing_sponsor = 0;
  let failed = 0;
  const { resolveRuntimeSponsorAccountId } = await import("./runtime-sponsor");
  for (const row of rows) {
    const sponsor_account_id = resolveRuntimeSponsorAccountId(row);
    if (!sponsor_account_id) {
      missing_sponsor += 1;
      continue;
    }
    const state = row.state?.state === "starting" ? "starting" : "running";
    try {
      const ok = await heartbeatProjectRuntimeSlot({
        sponsor_account_id,
        project_id: row.project_id,
        host_id: row.host_id,
        state,
        ttl_ms: HEARTBEAT_TTL_MS,
        metadata: {
          heartbeated_by: "owning-bay",
          owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
        },
      });
      if (ok) {
        heartbeated += 1;
        continue;
      }
      await reserveProjectRuntimeSlot({
        sponsor_account_id,
        project_id: row.project_id,
        owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
        host_id: row.host_id,
        reason: "runtime-slot-reconcile",
        state,
        ttl_ms: HEARTBEAT_TTL_MS,
        metadata: {
          heartbeated_by: "owning-bay",
          owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
        },
      });
      heartbeated += 1;
    } catch (err) {
      failed += 1;
      logger.warn("failed to heartbeat project runtime slot", {
        project_id: row.project_id,
        sponsor_account_id,
        err: `${err}`,
      });
    }
  }
  return { heartbeated, missing_sponsor, failed };
}

export function startProjectRuntimeSlotHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    heartbeatActiveProjectRuntimeSlotsOnOwningBay().catch((err) => {
      logger.warn("project runtime slot heartbeat failed", { err: `${err}` });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}
