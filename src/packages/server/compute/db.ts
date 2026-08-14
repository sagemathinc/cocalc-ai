/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomBytes, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { COMPUTE_VM_V2_SQL } from "./contract";
import type { ComputeVmRow, ComputeVolumeRow, ComputeWorkRow } from "./types";

const pool = () => getPool();
const MAX_COMPUTE_VM_SSH_KEYS = 32;
const MAX_COMPUTE_VM_SSH_KEY_METADATA_BYTES = 128 * 1024;

function sameProviderLocation(
  left: Pick<ComputeVmRow | ComputeVolumeRow, "provider" | "region" | "zone">,
  right: Pick<ComputeVmRow | ComputeVolumeRow, "provider" | "region" | "zone">,
): boolean {
  return (
    left.provider === right.provider &&
    left.region === right.region &&
    (left.zone ?? null) === (right.zone ?? null)
  );
}

export async function allocateComputeVmPublicHostname(
  dns: string,
  generateLabel = () => `vm-${randomBytes(16).toString("hex")}`,
): Promise<string> {
  const hostname = `${dns ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error("managed compute public DNS hostname is not configured");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const label = generateLabel().trim().toLowerCase();
    if (!/^vm-[a-f0-9]{32}$/.test(label)) {
      throw new Error("invalid managed compute public DNS label");
    }
    const candidate = `${label}.${hostname}`;
    const { rows } = await pool().query(
      "SELECT 1 FROM compute_vms WHERE public_hostname=$1 LIMIT 1",
      [candidate],
    );
    if (!rows.length) return candidate;
  }
  throw new Error("unable to allocate a unique managed compute hostname");
}

export async function insertComputeVm(
  row: Omit<
    ComputeVmRow,
    "created_at" | "updated_at" | "ready_at" | "stopped_at" | "deleted_at"
  >,
  limits?: {
    max_active_per_project: number;
    max_active_total: number;
  },
): Promise<ComputeVmRow> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<ComputeVmRow>(
      `SELECT * FROM compute_vms
       WHERE owner_account_id=$1 AND idempotency_key=$2
         AND ${COMPUTE_VM_V2_SQL}
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [row.owner_account_id, row.idempotency_key],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0];
    }
    if (limits) {
      // Serialize admission so concurrent creates cannot independently pass
      // the same project or site-wide capacity check.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('compute-vm-admission', 0))",
      );
      const { rows: projectRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM compute_vms
         WHERE project_id=$1 AND deleted_at IS NULL
           AND ${COMPUTE_VM_V2_SQL}`,
        [row.project_id],
      );
      const { rows: totalRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM compute_vms
         WHERE deleted_at IS NULL AND ${COMPUTE_VM_V2_SQL}`,
      );
      const projectCount = Number(projectRows[0]?.count ?? 0);
      const totalCount = Number(totalRows[0]?.count ?? 0);
      if (projectCount >= limits.max_active_per_project) {
        throw new Error(
          `managed compute VM project limit reached (${projectCount}/${limits.max_active_per_project})`,
        );
      }
      if (totalCount >= limits.max_active_total) {
        throw new Error(
          `managed compute VM site limit reached (${totalCount}/${limits.max_active_total})`,
        );
      }
    }
    const collision = await client.query(
      `SELECT id FROM compute_vms
       WHERE owner_account_id=$1 AND name=$2 AND deleted_at IS NULL
         AND ${COMPUTE_VM_V2_SQL}
       LIMIT 1 FOR UPDATE`,
      [row.owner_account_id, row.name],
    );
    if (collision.rowCount) {
      throw new Error(`compute VM name '${row.name}' is already in use`);
    }
    const { rows } = await client.query<ComputeVmRow>(
      `INSERT INTO compute_vms (
         id, name, owner_account_id, owning_bay_id, project_id, provider,
         operating_system, operating_system_version, os_license_hourly_price,
         region, zone, architecture, machine_type, cpu, ram_gb, gpu_type,
         gpu_count, provider_spec, funding_mode, desired_pricing_model,
         effective_pricing_model, boot_disk_gb, boot_disk_id, state,
         home_volume_id, desired_state, instance_generation,
         provider_instance_id, public_address_id, public_address_state,
         public_ip, public_hostname, dns_record_id, dns_state, dns_error,
         public_ports, ssh_user, ssh_public_key, created_at,
         updated_at, expires_at, bootstrap_revision,
         observed_bootstrap_revision, public_port_policy_revision,
         allow_on_demand_fallback, authorized_fallback_hours,
         spot_hourly_price, on_demand_hourly_price, authorized_cost,
         accrued_cost, billing_state, spot_recovery_policy,
         spot_recovery_state, idempotency_key, error, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
         $37,$38,NOW(),NOW(),$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
         $51,$52,$53,$54
       ) RETURNING *`,
      [
        row.id,
        row.name,
        row.owner_account_id,
        row.owning_bay_id,
        row.project_id,
        row.provider,
        row.operating_system,
        row.operating_system_version,
        row.os_license_hourly_price,
        row.region,
        row.zone,
        row.architecture,
        row.machine_type,
        row.cpu,
        row.ram_gb,
        row.gpu_type ?? null,
        row.gpu_count,
        row.provider_spec,
        row.funding_mode,
        row.desired_pricing_model,
        row.effective_pricing_model,
        row.boot_disk_gb,
        row.boot_disk_id,
        row.state,
        row.home_volume_id ?? null,
        row.desired_state,
        row.instance_generation,
        row.provider_instance_id,
        row.public_address_id ?? null,
        row.public_address_state,
        row.public_ip ?? null,
        row.public_hostname,
        row.dns_record_id ?? null,
        row.dns_state,
        row.dns_error ?? null,
        row.public_ports,
        row.ssh_user,
        row.ssh_public_key,
        row.expires_at,
        row.bootstrap_revision,
        row.observed_bootstrap_revision ?? null,
        row.public_port_policy_revision,
        row.allow_on_demand_fallback,
        row.authorized_fallback_hours,
        row.spot_hourly_price,
        row.on_demand_hourly_price,
        row.authorized_cost,
        row.accrued_cost,
        row.billing_state,
        row.spot_recovery_policy,
        row.spot_recovery_state,
        row.idempotency_key,
        row.error ?? null,
        row.metadata,
      ],
    );
    if (row.home_volume_id) {
      const { rows: volumes } = await client.query<ComputeVolumeRow>(
        `SELECT * FROM compute_volumes
         WHERE id=$1 AND owner_account_id=$2 AND deleted_at IS NULL
         FOR UPDATE`,
        [row.home_volume_id, row.owner_account_id],
      );
      const volume = volumes[0];
      if (!volume) throw new Error("compute volume not found or access denied");
      if (!sameProviderLocation(volume, row)) {
        throw new Error(
          "compute volume and VM must use the same provider location",
        );
      }
      if (volume.state !== "ready" || volume.desired_state !== "ready") {
        throw new Error(`compute volume is not ready (state=${volume.state})`);
      }
      if (volume.attached_vm_id && volume.attached_vm_id !== row.id) {
        throw new Error("compute volume is already reserved by another VM");
      }
      await client.query(
        `UPDATE compute_volumes
         SET attached_vm_id=$2, attachment_state='reserved',
             attachment_generation=attachment_generation+1, updated_at=NOW()
         WHERE id=$1`,
        [volume.id, row.id],
      );
    }
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getComputeVmById(id: string) {
  const { rows } = await pool().query<ComputeVmRow>(
    "SELECT * FROM compute_vms WHERE id=$1",
    [id],
  );
  return rows[0];
}

export async function resolveOwnedComputeVm(opts: {
  owner_account_id: string;
  id_or_name: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
     WHERE owner_account_id=$1
       AND (id::text=$2 OR name=$2)
       AND ${COMPUTE_VM_V2_SQL}
       ${deletedClause}
     ORDER BY created_at DESC LIMIT 1`,
    [opts.owner_account_id, opts.id_or_name],
  );
  return rows[0];
}

export async function resolveProjectComputeVm(opts: {
  project_id: string;
  id_or_name: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
     WHERE project_id=$1
       AND (id::text=$2 OR name=$2)
       AND ${COMPUTE_VM_V2_SQL}
       ${deletedClause}
     ORDER BY created_at DESC LIMIT 2`,
    [opts.project_id, opts.id_or_name],
  );
  if (rows.length > 1) {
    throw new Error(
      `compute VM name '${opts.id_or_name}' is ambiguous in this project; use its UUID`,
    );
  }
  return rows[0];
}

export async function listOwnedComputeVms(opts: {
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
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
     WHERE owner_account_id=$1 ${projectClause} ${deletedClause}
       AND ${COMPUTE_VM_V2_SQL}
     ORDER BY created_at DESC`,
    params,
  );
  return rows;
}

export async function listProjectComputeVms(opts: {
  project_id: string;
  include_deleted?: boolean;
}) {
  const deletedClause = opts.include_deleted ? "" : "AND deleted_at IS NULL";
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
     WHERE project_id=$1 ${deletedClause}
       AND ${COMPUTE_VM_V2_SQL}
     ORDER BY created_at DESC`,
    [opts.project_id],
  );
  return rows;
}

export async function listComputeVmsForBillingEnforcement() {
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
      WHERE deleted_at IS NULL
        AND desired_state <> 'deleted'
        AND ${COMPUTE_VM_V2_SQL}
      ORDER BY owner_account_id, created_at`,
  );
  return rows;
}

export async function listComputeVmsForInventory() {
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  );
  return rows;
}

export async function listComputeVmsForEgressMetering() {
  const { rows } = await pool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
      WHERE (
          deleted_at IS NULL
          OR COALESCE((metadata#>>'{billing,egress,finalized}')::boolean, FALSE) IS NOT TRUE
        )
        AND ${COMPUTE_VM_V2_SQL}
      ORDER BY created_at`,
  );
  return rows;
}

export async function updateComputeVmEgressMetadata(
  id: string,
  egress: Record<string, unknown>,
): Promise<ComputeVmRow | undefined> {
  const { rows } = await pool().query<ComputeVmRow>(
    `UPDATE compute_vms
        SET metadata=jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{billing}',
              COALESCE(metadata->'billing', '{}'::jsonb) ||
                jsonb_build_object('egress', $2::jsonb),
              true
            ),
            updated_at=NOW()
      WHERE id=$1
      RETURNING *`,
    [id, egress],
  );
  return rows[0];
}

export async function updateComputeVm(
  id: string,
  updates: Partial<ComputeVmRow>,
) {
  const allowed = new Set([
    "state",
    "desired_state",
    "effective_pricing_model",
    "funding_mode",
    "machine_type",
    "cpu",
    "ram_gb",
    "gpu_type",
    "gpu_count",
    "provider_spec",
    "os_license_hourly_price",
    "spot_hourly_price",
    "on_demand_hourly_price",
    "provider_instance_id",
    "instance_generation",
    "public_address_id",
    "public_address_state",
    "public_address_updated_at",
    "public_ip",
    "dns_record_id",
    "dns_state",
    "dns_updated_at",
    "dns_error",
    "observed_bootstrap_revision",
    "ready_at",
    "stopped_at",
    "deleted_at",
    "error",
    "metadata",
    "spot_recovery_state",
    "expires_at",
    "billing_state",
    "billing_updated_at",
  ]);
  const entries = Object.entries(updates).filter(([key]) => allowed.has(key));
  if (!entries.length) return await getComputeVmById(id);
  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`);
  const { rows } = await pool().query<ComputeVmRow>(
    `UPDATE compute_vms SET ${assignments.join(", ")}, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, ...values],
  );
  return rows[0];
}

export async function addComputeVmSshPublicKey({
  id,
  owner_account_id,
  ssh_public_key,
}: {
  id: string;
  owner_account_id: string;
  ssh_public_key: string;
}): Promise<{ vm: ComputeVmRow; added: boolean }> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ComputeVmRow>(
      "SELECT * FROM compute_vms " +
        "WHERE id=$1 AND owner_account_id=$2 AND deleted_at IS NULL " +
        "FOR UPDATE",
      [id, owner_account_id],
    );
    const vm = rows[0];
    if (!vm) {
      throw new Error("compute VM not found or access denied");
    }
    const sshPublicKeys = Array.from(
      new Set(
        [
          vm.ssh_public_key,
          ...(Array.isArray(vm.metadata?.ssh_public_keys)
            ? vm.metadata.ssh_public_keys
            : []),
        ]
          .map((value) => String(value ?? "").trim())
          .filter(Boolean),
      ),
    );
    if (sshPublicKeys.includes(ssh_public_key)) {
      await client.query("COMMIT");
      return { vm, added: false };
    }
    if (sshPublicKeys.length >= MAX_COMPUTE_VM_SSH_KEYS) {
      throw new Error(
        "compute VM SSH key limit reached (" + MAX_COMPUTE_VM_SSH_KEYS + ")",
      );
    }
    const metadataBytes =
      sshPublicKeys.reduce((total, key) => total + Buffer.byteLength(key), 0) +
      Buffer.byteLength(ssh_public_key);
    if (metadataBytes > MAX_COMPUTE_VM_SSH_KEY_METADATA_BYTES) {
      throw new Error("compute VM SSH public key metadata is too large");
    }
    sshPublicKeys.push(ssh_public_key);
    const metadata = { ...vm.metadata, ssh_public_keys: sshPublicKeys };
    const updated = await client.query<ComputeVmRow>(
      "UPDATE compute_vms " +
        "SET metadata=$2::jsonb, updated_at=NOW() " +
        "WHERE id=$1 RETURNING *",
      [id, JSON.stringify(metadata)],
    );
    await client.query("COMMIT");
    return { vm: updated.rows[0]!, added: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function insertComputeInstance(vm: ComputeVmRow) {
  await pool().query(
    `INSERT INTO compute_vm_instances (
       id, vm_id, owner_account_id, owning_bay_id, project_id, generation,
       provider_instance_id, machine_type, pricing_model, public_ip,
       public_address_id, hourly_price, created_at
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM compute_vm_instances WHERE vm_id=$2 AND generation=$6
     )`,
    [
      randomUUID(),
      vm.id,
      vm.owner_account_id,
      vm.owning_bay_id,
      vm.project_id,
      vm.instance_generation,
      vm.provider_instance_id,
      vm.machine_type,
      vm.effective_pricing_model,
      vm.public_ip ?? null,
      vm.public_address_id ?? null,
      vm.effective_pricing_model === "spot"
        ? vm.spot_hourly_price
        : vm.on_demand_hourly_price,
    ],
  );
}

export async function updateComputeInstance(
  vm: ComputeVmRow,
  updates: {
    public_ip?: string | null;
    running?: boolean;
    ready?: boolean;
    stopped?: boolean;
    deleted?: boolean;
  },
) {
  const sets: string[] = [];
  const values: any[] = [vm.id, vm.instance_generation];
  const addValue = (sql: string, value: any) => {
    values.push(value);
    sets.push(`${sql}=$${values.length}`);
  };
  if (updates.public_ip !== undefined) {
    addValue("public_ip", updates.public_ip);
  }
  if (updates.running) sets.push("running_at=COALESCE(running_at,NOW())");
  if (updates.ready) sets.push("ready_at=COALESCE(ready_at,NOW())");
  if (updates.stopped) sets.push("stopped_at=COALESCE(stopped_at,NOW())");
  if (updates.deleted) sets.push("deleted_at=COALESCE(deleted_at,NOW())");
  if (!sets.length) return;
  await pool().query(
    `UPDATE compute_vm_instances SET ${sets.join(", ")}
     WHERE vm_id=$1 AND generation=$2`,
    values,
  );
}

export async function appendComputeEvent(opts: {
  vm: ComputeVmRow;
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
     ) VALUES ($1,'vm',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
    [
      randomUUID(),
      opts.vm.id,
      opts.vm.owner_account_id,
      opts.vm.project_id,
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

export async function enqueueComputeWork(opts: {
  resource_kind?: "vm" | "volume";
  resource_id: string;
  action: string;
  idempotency_key: string;
  payload?: Record<string, any>;
  not_before?: Date;
}) {
  const id = randomUUID();
  const { rowCount } = await pool().query(
    `INSERT INTO compute_resource_work (
       id, resource_kind, resource_id, action, idempotency_key, payload,
       state, attempt, not_before, created_at, updated_at
     )
     SELECT $1,$7,$2,$3,$4,$5,'queued',0,$6,NOW(),NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM compute_resource_work
       WHERE resource_id=$2 AND action=$3 AND state IN ('queued','in_progress')
     )`,
    [
      id,
      opts.resource_id,
      opts.action,
      opts.idempotency_key,
      opts.payload ?? {},
      opts.not_before ?? null,
      opts.resource_kind ?? "vm",
    ],
  );
  return rowCount ? id : undefined;
}

export async function claimComputeWork(opts: {
  worker_id: string;
  limit: number;
}) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE compute_resource_work
       SET state='queued', locked_by=NULL, locked_at=NULL,
           attempt=attempt+1, updated_at=NOW(), error='requeued stale work'
       WHERE state='in_progress' AND locked_at < NOW() - interval '10 minutes'`,
    );
    const { rows } = await client.query<ComputeWorkRow>(
      `SELECT work.* FROM compute_resource_work AS work
       WHERE work.state='queued'
         AND (work.not_before IS NULL OR work.not_before <= NOW())
         AND NOT EXISTS (
           SELECT 1 FROM compute_resource_work AS active
           WHERE active.resource_id=work.resource_id
             AND active.state='in_progress'
         )
         AND NOT EXISTS (
           SELECT 1 FROM compute_resource_work AS earlier
           WHERE earlier.resource_id=work.resource_id
             AND earlier.state='queued'
             AND (earlier.not_before IS NULL OR earlier.not_before <= NOW())
             AND earlier.queue_order < work.queue_order
         )
       ORDER BY work.queue_order
       LIMIT $1 FOR UPDATE OF work SKIP LOCKED`,
      [opts.limit],
    );
    if (rows.length) {
      await client.query(
        `UPDATE compute_resource_work
         SET state='in_progress', locked_by=$1, locked_at=NOW(), updated_at=NOW()
         WHERE id=ANY($2::uuid[])`,
        [opts.worker_id, rows.map(({ id }) => id)],
      );
    }
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finishComputeWork(opts: {
  id: string;
  state: "done" | "failed";
  error?: string;
}) {
  await pool().query(
    `UPDATE compute_resource_work
     SET state=$2, error=$3, locked_by=NULL, locked_at=NULL, updated_at=NOW()
     WHERE id=$1`,
    [opts.id, opts.state, opts.error?.slice(0, 4000) ?? null],
  );
}

export async function enqueueExpiredComputeVms(limit = 100) {
  const { rows } = await pool().query<{ id: string }>(
    `UPDATE compute_vms
     SET desired_state='deleted', state='deleting', updated_at=NOW(),
         error='lease expired'
     WHERE id IN (
       SELECT id FROM compute_vms
       WHERE deleted_at IS NULL AND expires_at IS NOT NULL
         AND expires_at <= NOW()
         AND ${COMPUTE_VM_V2_SQL}
       ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [limit],
  );
  for (const { id } of rows) {
    await enqueueComputeWork({
      resource_id: id,
      action: "delete",
      idempotency_key: `expire:${id}`,
    });
  }
  return rows.length;
}

export async function enqueueComputeEmergencyStops(limit = 100) {
  const { rows } = await pool().query<{ id: string }>(
    `UPDATE compute_vms
     SET desired_state='stopped', updated_at=NOW(),
         error='site-wide emergency stop requested'
     WHERE id IN (
       SELECT id FROM compute_vms
       WHERE deleted_at IS NULL AND desired_state='running'
         AND ${COMPUTE_VM_V2_SQL}
       ORDER BY updated_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [limit],
  );
  for (const { id } of rows) {
    await enqueueComputeWork({
      resource_id: id,
      action: "reconcile",
      idempotency_key: `emergency-stop:${id}:${Date.now()}`,
    });
  }
  return rows.length;
}

export async function enqueueComputeReconciliation(limit = 100) {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id FROM compute_vms
     WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
       AND ${COMPUTE_VM_V2_SQL}
     ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  for (const { id } of rows) {
    await enqueueComputeWork({
      resource_id: id,
      action: "reconcile",
      idempotency_key: `reconcile:${id}`,
    });
  }
  return rows.length;
}
