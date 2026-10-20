/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  ComputeVmProjectAccessRow,
  ComputeVmProjectAccessState,
  ComputeVmRow,
} from "./types";

const pool = () => getPool();

export async function listComputeVmProjectAccess(opts: {
  owner_account_id?: string;
  vm_id?: string;
  project_id?: string;
  include_revoked?: boolean;
}): Promise<ComputeVmProjectAccessRow[]> {
  const conditions: string[] = [];
  const values: string[] = [];
  const add = (column: string, value?: string) => {
    if (!value) return;
    values.push(value);
    conditions.push(`${column}=$${values.length}`);
  };
  add("owner_account_id", opts.owner_account_id);
  add("vm_id", opts.vm_id);
  add("project_id", opts.project_id);
  if (!conditions.length) {
    throw new Error("managed compute project access query requires a scope");
  }
  if (!opts.include_revoked) {
    // Keep incomplete revocations visible to operators until provider and
    // project-side reconciliation have actually converged.
    conditions.push("(revoked_at IS NULL OR state <> 'revoked')");
  }
  const { rows } = await pool().query<ComputeVmProjectAccessRow>(
    `SELECT * FROM compute_vm_project_access
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at, project_id`,
    values,
  );
  return rows;
}

export async function grantComputeVmProjectAccess(opts: {
  owner_account_id: string;
  vm_id: string;
  project_id: string;
  ssh_public_key: string;
  created_by_account_id: string;
}): Promise<ComputeVmProjectAccessRow> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: vms } = await client.query<ComputeVmRow>(
      `SELECT * FROM compute_vms
        WHERE id=$1 AND owner_account_id=$2 AND deleted_at IS NULL
        FOR UPDATE`,
      [opts.vm_id, opts.owner_account_id],
    );
    const vm = vms[0];
    if (!vm) throw new Error("compute VM not found or access denied");
    const { rows } = await client.query<ComputeVmProjectAccessRow>(
      `INSERT INTO compute_vm_project_access (
         vm_id, project_id, owner_account_id, owning_bay_id, access_level,
         ssh_public_key, state, created_by_account_id, created_at, updated_at,
         revoked_at, error, metadata
       ) VALUES ($1,$2,$3,$4,'connect',$5,'pending',$6,NOW(),NOW(),NULL,NULL,'{}')
       ON CONFLICT (vm_id, project_id) DO UPDATE SET
         owner_account_id=EXCLUDED.owner_account_id,
         owning_bay_id=EXCLUDED.owning_bay_id,
         access_level='connect',
         ssh_public_key=EXCLUDED.ssh_public_key,
         state=CASE
           WHEN compute_vm_project_access.revoked_at IS NULL
             AND compute_vm_project_access.ssh_public_key=EXCLUDED.ssh_public_key
             AND compute_vm_project_access.state='ready'
           THEN 'ready'
           ELSE 'pending'
         END,
         created_by_account_id=EXCLUDED.created_by_account_id,
         updated_at=NOW(),
         revoked_at=NULL,
         error=NULL
       RETURNING *`,
      [
        vm.id,
        opts.project_id,
        vm.owner_account_id,
        vm.owning_bay_id,
        opts.ssh_public_key,
        opts.created_by_account_id,
      ],
    );
    await client.query("COMMIT");
    return rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeComputeVmProjectAccess(opts: {
  owner_account_id: string;
  vm_id: string;
  project_id: string;
}): Promise<ComputeVmProjectAccessRow> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ComputeVmProjectAccessRow>(
      `SELECT * FROM compute_vm_project_access
        WHERE vm_id=$1 AND project_id=$2 AND owner_account_id=$3
        FOR UPDATE`,
      [opts.vm_id, opts.project_id, opts.owner_account_id],
    );
    const current = rows[0];
    if (!current) throw new Error("VM project access not found");
    if (current.revoked_at) {
      await client.query("COMMIT");
      return current;
    }
    const { rows: updated } = await client.query<ComputeVmProjectAccessRow>(
      `UPDATE compute_vm_project_access
          SET state='revoking', revoked_at=NOW(), updated_at=NOW(), error=NULL
        WHERE vm_id=$1 AND project_id=$2
        RETURNING *`,
      [opts.vm_id, opts.project_id],
    );
    await client.query("COMMIT");
    return updated[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateComputeVmProjectAccessState(opts: {
  vm_id: string;
  project_id: string;
  state: ComputeVmProjectAccessState;
  error?: string | null;
  /** Count a failed project sync (metadata.sync_failures, for backoff);
   * any other update resets the count. */
  sync_failed?: boolean;
}): Promise<ComputeVmProjectAccessRow | undefined> {
  const { rows } = await pool().query<ComputeVmProjectAccessRow>(
    `UPDATE compute_vm_project_access
        SET state=$3, error=$4, updated_at=NOW(),
            metadata=CASE
              WHEN $5::boolean THEN jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{sync_failures}',
                to_jsonb(COALESCE((metadata->>'sync_failures')::int, 0) + 1)
              )
              ELSE COALESCE(metadata, '{}'::jsonb) - 'sync_failures'
            END
      WHERE vm_id=$1 AND project_id=$2
      RETURNING *`,
    [
      opts.vm_id,
      opts.project_id,
      opts.state,
      opts.error ?? null,
      opts.sync_failed === true,
    ],
  );
  return rows[0];
}

export async function refreshComputeVmProjectAccessKey(opts: {
  vm_id: string;
  project_id: string;
  ssh_public_key: string;
}): Promise<ComputeVmProjectAccessRow | undefined> {
  const { rows } = await pool().query<ComputeVmProjectAccessRow>(
    `UPDATE compute_vm_project_access
        SET ssh_public_key=$3,
            state=CASE
              WHEN ssh_public_key=$3 AND state='ready' THEN 'ready'
              ELSE 'pending'
            END,
            error=NULL,
            updated_at=NOW()
      WHERE vm_id=$1 AND project_id=$2 AND revoked_at IS NULL
      RETURNING *`,
    [opts.vm_id, opts.project_id, opts.ssh_public_key],
  );
  return rows[0];
}

export async function activeComputeVmProjectKeys(
  vm_id: string,
): Promise<string[]> {
  const { rows } = await pool().query<{ ssh_public_key: string }>(
    `SELECT ssh_public_key FROM compute_vm_project_access
      WHERE vm_id=$1 AND revoked_at IS NULL
        AND NULLIF(BTRIM(ssh_public_key), '') IS NOT NULL
      ORDER BY project_id`,
    [vm_id],
  );
  return Array.from(new Set(rows.map(({ ssh_public_key }) => ssh_public_key)));
}
