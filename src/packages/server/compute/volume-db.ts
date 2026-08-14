/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { COMPUTE_VOLUME_V2_SQL } from "./contract";
import { enqueueComputeWork } from "./db";
import type { ComputeVolumeRow } from "./types";

const pool = () => getPool();

type NewVolume = Omit<
  ComputeVolumeRow,
  | "created_at"
  | "updated_at"
  | "ready_at"
  | "resized_at"
  | "detached_at"
  | "deleted_at"
>;

export async function insertComputeVolume(
  row: NewVolume,
  maxPerAccount: number,
): Promise<ComputeVolumeRow> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<ComputeVolumeRow>(
      `SELECT * FROM compute_volumes
       WHERE owner_account_id=$1 AND idempotency_key=$2
         AND ${COMPUTE_VOLUME_V2_SQL}
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [row.owner_account_id, row.idempotency_key],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0];
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('compute-volume-admission', 0))",
    );
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM compute_volumes
       WHERE owner_account_id=$1 AND deleted_at IS NULL
         AND ${COMPUTE_VOLUME_V2_SQL}`,
      [row.owner_account_id],
    );
    const count = Number(countRows[0]?.count ?? 0);
    if (count >= maxPerAccount) {
      throw new Error(
        `managed compute volume account limit reached (${count}/${maxPerAccount})`,
      );
    }
    const collision = await client.query(
      `SELECT id FROM compute_volumes
       WHERE owner_account_id=$1 AND name=$2 AND deleted_at IS NULL
         AND ${COMPUTE_VOLUME_V2_SQL}
       LIMIT 1 FOR UPDATE`,
      [row.owner_account_id, row.name],
    );
    if (collision.rowCount) {
      throw new Error(`compute volume name '${row.name}' is already in use`);
    }
    const { rows } = await client.query<ComputeVolumeRow>(
      `INSERT INTO compute_volumes (
         id, name, owner_account_id, owning_bay_id, project_id, provider, region, zone,
         role, funding_mode, provider_spec, disk_type, filesystem, size_gb,
         desired_size_gb, effective_size_gb, provider_disk_id,
         state, desired_state, attached_vm_id, attachment_generation,
         attachment_state, created_at, updated_at, monthly_price_per_gb,
         authorized_monthly_cost, billing_state, idempotency_key, error, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,NOW(),NOW(),$23,$24,$25,$26,$27,$28
       ) RETURNING *`,
      [
        row.id,
        row.name,
        row.owner_account_id,
        row.owning_bay_id,
        row.project_id ?? null,
        row.provider,
        row.region,
        row.zone,
        row.role,
        row.funding_mode,
        row.provider_spec,
        row.disk_type,
        row.filesystem,
        row.size_gb,
        row.desired_size_gb,
        row.effective_size_gb,
        row.provider_disk_id,
        row.state,
        row.desired_state,
        row.attached_vm_id ?? null,
        row.attachment_generation,
        row.attachment_state,
        row.monthly_price_per_gb,
        row.authorized_monthly_cost,
        row.billing_state,
        row.idempotency_key,
        row.error ?? null,
        row.metadata,
      ],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getComputeVolumeById(id: string) {
  const { rows } = await pool().query<ComputeVolumeRow>(
    "SELECT * FROM compute_volumes WHERE id=$1",
    [id],
  );
  return rows[0];
}

export async function resolveOwnedComputeVolume(opts: {
  owner_account_id: string;
  id_or_name: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
     WHERE owner_account_id=$1 AND (id::text=$2 OR name=$2) ${deletedClause}
       AND ${COMPUTE_VOLUME_V2_SQL}
     ORDER BY created_at DESC LIMIT 1`,
    [opts.owner_account_id, opts.id_or_name],
  );
  return rows[0];
}

export async function resolveProjectComputeVolume(opts: {
  project_id: string;
  id_or_name: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
     WHERE project_id=$1 AND (id::text=$2 OR name=$2) ${deletedClause}
       AND ${COMPUTE_VOLUME_V2_SQL}
     ORDER BY created_at DESC LIMIT 2`,
    [opts.project_id, opts.id_or_name],
  );
  if (rows.length > 1) {
    throw new Error(
      `compute volume name '${opts.id_or_name}' is ambiguous in this project; use its UUID`,
    );
  }
  return rows[0];
}

export async function listOwnedComputeVolumes(opts: {
  owner_account_id: string;
  project_id?: string;
  include_deleted?: boolean;
}) {
  const params: any[] = [opts.owner_account_id];
  let projectClause = "";
  if (opts.project_id) {
    params.push(opts.project_id);
    projectClause = `AND project_id=$${params.length}`;
  }
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
     WHERE owner_account_id=$1 ${projectClause} ${deletedClause}
       AND ${COMPUTE_VOLUME_V2_SQL}
     ORDER BY created_at DESC`,
    params,
  );
  return rows;
}

export async function listProjectComputeVolumes(opts: {
  project_id: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
     WHERE project_id=$1 ${deletedClause}
       AND ${COMPUTE_VOLUME_V2_SQL}
     ORDER BY created_at DESC`,
    [opts.project_id],
  );
  return rows;
}

export async function listComputeVolumesForInventory() {
  const { rows } = await pool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  );
  return rows;
}

export async function updateComputeVolume(
  id: string,
  updates: Partial<ComputeVolumeRow>,
) {
  const allowed = new Set([
    "project_id",
    "size_gb",
    "desired_size_gb",
    "effective_size_gb",
    "funding_mode",
    "state",
    "desired_state",
    "attached_vm_id",
    "attachment_state",
    "ready_at",
    "resized_at",
    "detached_at",
    "deleted_at",
    "monthly_price_per_gb",
    "authorized_monthly_cost",
    "billing_state",
    "billing_updated_at",
    "error",
    "metadata",
  ]);
  const entries = Object.entries(updates).filter(([key]) => allowed.has(key));
  if (!entries.length) return await getComputeVolumeById(id);
  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`);
  const { rows } = await pool().query<ComputeVolumeRow>(
    `UPDATE compute_volumes SET ${assignments.join(", ")}, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, ...values],
  );
  return rows[0];
}

export async function detachComputeVolumeFromVm(vmId: string) {
  const { rows } = await pool().query<ComputeVolumeRow>(
    `UPDATE compute_volumes
     SET attached_vm_id=NULL, attachment_state='detached', detached_at=NOW(),
         updated_at=NOW()
     WHERE attached_vm_id=$1 AND deleted_at IS NULL RETURNING *`,
    [vmId],
  );
  return rows[0];
}

export async function appendComputeVolumeEvent(opts: {
  volume: ComputeVolumeRow;
  actor_account_id?: string;
  actor_kind: string;
  action: string;
  idempotency_key: string;
  old_state?: string;
  new_state?: string;
  status: string;
  details?: Record<string, any>;
}) {
  await pool().query(
    `INSERT INTO compute_resource_events (
       id, resource_kind, resource_id, owner_account_id, project_id,
       actor_account_id, actor_kind, action, idempotency_key, old_state,
       new_state, status, details, created_at
     ) VALUES ($1,'volume',$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
    [
      randomUUID(),
      opts.volume.id,
      opts.volume.owner_account_id,
      opts.actor_account_id ?? null,
      opts.actor_kind,
      opts.action,
      opts.idempotency_key,
      opts.old_state ?? null,
      opts.new_state ?? null,
      opts.status,
      opts.details ?? {},
    ],
  );
}

export async function enqueueComputeVolumeReconciliation(limit = 100) {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id FROM compute_volumes
     WHERE deleted_at IS NULL AND ${COMPUTE_VOLUME_V2_SQL}
     ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  for (const { id } of rows) {
    await enqueueComputeWork({
      resource_kind: "volume",
      resource_id: id,
      action: "reconcile_volume",
      idempotency_key: `reconcile-volume:${id}:${Date.now()}`,
    });
  }
  return rows.length;
}
