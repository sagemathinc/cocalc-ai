import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { COMPUTE_VM_V2_SQL } from "./contract";
import type { ComputeVmRow } from "./types";
import { applyPreparedCourseRestart } from "./funding/vm-restart";
import type { PreparedCourseRestart } from "./funding/vm-restart";

export const DEFAULT_STOP_AFTER_MINUTES = 360;

export function scheduledStopLockKey(id: string) {
  return `compute-scheduled-stop:${id}`;
}

export function validateStopAfterMinutes(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 525600) {
    throw new Error(
      "stop_after_minutes must be a whole number from 1 to 525600, or null",
    );
  }
  return value;
}

export function createStopSchedule(
  value: number | null | undefined,
  agent = false,
  now = Date.now(),
) {
  const minutes = validateStopAfterMinutes(
    value === undefined ? DEFAULT_STOP_AFTER_MINUTES : value,
  );
  if (agent && (minutes === null || minutes > DEFAULT_STOP_AFTER_MINUTES)) {
    throw Object.assign(
      new Error("owner approval required to extend or disable scheduled stop"),
      { code: 403 },
    );
  }
  return {
    stop_after_minutes: minutes,
    stop_at: minutes === null ? null : new Date(now + minutes * 60000),
    stop_generation: 1,
  };
}

export function startStopSchedule(
  vm: ComputeVmRow,
  requested: number | null | undefined,
  agent: boolean,
  now = Date.now(),
) {
  const minutes = validateStopAfterMinutes(
    requested === undefined ? (vm.stop_after_minutes ?? null) : requested,
  );
  // Repeated availability requests and provider recovery must not move a clock.
  const reset = requested !== undefined || vm.desired_state !== "running";
  let stopAt = reset
    ? minutes === null
      ? null
      : new Date(now + minutes * 60000)
    : (vm.stop_at ?? null);
  if (agent) {
    if (requested === undefined) stopAt = vm.stop_at ?? null;
    const extendsDeadline =
      vm.stop_at != null &&
      (stopAt === null || stopAt.valueOf() > vm.stop_at.valueOf());
    const extendsChoice =
      vm.stop_after_minutes != null &&
      (minutes === null || minutes > vm.stop_after_minutes);
    if (
      extendsDeadline ||
      extendsChoice ||
      (stopAt != null && stopAt.valueOf() <= now)
    ) {
      throw Object.assign(
        new Error(
          "owner approval required to establish a later scheduled stop deadline",
        ),
        { code: 403 },
      );
    }
  }
  return {
    stop_after_minutes: minutes,
    stop_at: stopAt,
    stop_generation: (vm.stop_generation ?? 0) + (reset ? 1 : 0),
  };
}

/** Called only after account-home routing, ownership, funding and actor checks. */
export async function requestScheduledVmState(opts: {
  vm: ComputeVmRow;
  desired_state: "running" | "stopped";
  stop_after_minutes?: number | null;
  actor_kind: string;
  idempotency_key: string;
  prepared_funding?: PreparedCourseRestart;
}): Promise<ComputeVmRow> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      scheduledStopLockKey(opts.vm.id),
    ]);
    const { rows } = await client.query<ComputeVmRow>(
      "SELECT * FROM compute_vms WHERE id=$1 AND owning_bay_id=$2 FOR UPDATE",
      [opts.vm.id, getConfiguredBayId()],
    );
    let vm = rows[0];
    if (!vm || vm.deleted_at || vm.desired_state === "deleted")
      throw new Error("compute VM is deleted or belongs to another bay");
    const action = opts.desired_state === "running" ? "start" : "stop";
    const replay = await client.query(
      `SELECT 1 FROM compute_resource_events WHERE resource_id=$1 AND action=$2 AND idempotency_key=$3 AND status='requested' LIMIT 1`,
      [vm.id, action, opts.idempotency_key],
    );
    if (replay.rows.length) {
      await client.query("COMMIT");
      return vm;
    }
    // Do not commit against a policy/state changed while authorization ran.
    if (
      (vm.stop_generation ?? 0) !== (opts.vm.stop_generation ?? 0) ||
      vm.desired_state !== opts.vm.desired_state
    ) {
      throw new Error("VM state or stop schedule changed; retry the request");
    }
    const schedule =
      opts.desired_state === "running"
        ? startStopSchedule(
            vm,
            opts.stop_after_minutes,
            opts.actor_kind === "agent",
          )
        : {
            stop_at: vm.stop_at ?? null,
            stop_after_minutes: vm.stop_after_minutes ?? null,
            stop_generation: vm.stop_generation ?? 0,
          };
    if (opts.prepared_funding)
      vm = await applyPreparedCourseRestart(client, vm, opts.prepared_funding);
    const updated = await client.query<ComputeVmRow>(
      `UPDATE compute_vms SET desired_state=$2, state=$3, stop_at=$4,
       stop_after_minutes=$5, stop_generation=$6, error=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [
        vm.id,
        opts.desired_state,
        opts.desired_state === "running" ? "starting" : "stopping",
        schedule.stop_at,
        schedule.stop_after_minutes,
        schedule.stop_generation,
      ],
    );
    await client.query(
      `INSERT INTO compute_resource_events (id,resource_kind,resource_id,owner_account_id,project_id,actor_account_id,actor_kind,action,idempotency_key,old_state,new_state,status,details,created_at)
       VALUES ($1,'vm',$2,$3,$4,$3,$5,$6,$7,$8,$9,'requested',$10,NOW())`,
      [
        randomUUID(),
        vm.id,
        vm.owner_account_id,
        vm.project_id ?? null,
        opts.actor_kind,
        action,
        opts.idempotency_key,
        vm.state,
        updated.rows[0].state,
        schedule,
      ],
    );
    // Intent and reconciliation are durable together. Reconcile reads the live
    // schedule, so an old queued stop cannot stop a newly authorized generation.
    await client.query(
      `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,created_at,updated_at)
       VALUES ($1,'vm',$2,'reconcile',$3,'{}','queued',0,NOW(),NOW())`,
      [randomUUID(), vm.id, opts.idempotency_key],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Bay-local durable sweep, independent of browser, guest activity and work slots. */
export async function enqueueScheduledComputeStops(
  limit = 100,
  vmId?: string,
): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM compute_vms WHERE owning_bay_id=$1
         AND deleted_at IS NULL AND desired_state='running'
         AND stop_at <= NOW() AND ${COMPUTE_VM_V2_SQL}
         AND ($3::uuid IS NULL OR id=$3)
       ORDER BY stop_at LIMIT $2 FOR UPDATE SKIP LOCKED
     ), stopped AS (
       UPDATE compute_vms SET desired_state='stopped', state='stopping',
         error='scheduled stop deadline reached', updated_at=NOW()
       WHERE id IN (SELECT id FROM due) RETURNING *
     ), audit AS (
       INSERT INTO compute_resource_events (id,resource_kind,resource_id,owner_account_id,project_id,actor_kind,action,idempotency_key,new_state,status,details,created_at)
       SELECT gen_random_uuid(),'vm',id,owner_account_id,project_id,'worker',
         'scheduled-stop','scheduled-stop:' || id || ':' || COALESCE(stop_generation,0),
         'stopping','requested',jsonb_build_object('stop_at',stop_at,'stop_generation',stop_generation),NOW()
       FROM stopped RETURNING id
     )
     INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,created_at,updated_at)
     SELECT gen_random_uuid(),'vm',id,'reconcile',
       'scheduled-stop:' || id || ':' || COALESCE(stop_generation,0),
       '{}','queued',0,NOW(),NOW() FROM stopped RETURNING resource_id AS id`,
    [getConfiguredBayId(), limit, vmId ?? null],
  );
  return rows.length;
}
