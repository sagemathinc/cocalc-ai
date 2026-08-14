/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { ManagedComputeProviderId } from "./types";

export type ComputeOrphanResourceType =
  | "instance"
  | "boot_disk"
  | "address"
  | "dns_record";

export interface ComputeOrphanObservation {
  provider: ManagedComputeProviderId | "cloudflare";
  resource_type: ComputeOrphanResourceType;
  resource_id: string;
  resource_name?: string;
  region?: string;
  zone?: string;
  metadata?: Record<string, any>;
}

export interface ComputeOrphanRow extends Omit<
  ComputeOrphanObservation,
  "metadata"
> {
  id: string;
  state: string;
  observation_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  stopped_at?: Date | null;
  eligible_delete_at?: Date | null;
  resolved_at?: Date | null;
  last_error?: string | null;
  metadata: Record<string, any>;
}

export function computeOrphanId(
  observation: Pick<
    ComputeOrphanObservation,
    "provider" | "resource_type" | "resource_id"
  >,
): string {
  return createHash("sha256")
    .update(
      `${observation.provider}\0${observation.resource_type}\0${observation.resource_id}`,
    )
    .digest("hex");
}

export async function observeComputeOrphan(
  observation: ComputeOrphanObservation,
  graceMs: number,
): Promise<ComputeOrphanRow> {
  const id = computeOrphanId(observation);
  const { rows } = await getPool().query<ComputeOrphanRow>(
    `INSERT INTO compute_vm_orphans (
       id, provider, resource_type, resource_id, resource_name, region, zone,
       state, observation_count, first_seen_at, last_seen_at,
       eligible_delete_at, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'observed',1,NOW(),NOW(),
               NOW() + ($8 * INTERVAL '1 millisecond'),$9)
     ON CONFLICT (id) DO UPDATE SET
       resource_name=EXCLUDED.resource_name,
       region=EXCLUDED.region,
       zone=EXCLUDED.zone,
       observation_count=compute_vm_orphans.observation_count+1,
       last_seen_at=NOW(),
       resolved_at=NULL,
       metadata=EXCLUDED.metadata
     RETURNING *`,
    [
      id,
      observation.provider,
      observation.resource_type,
      observation.resource_id,
      observation.resource_name ?? null,
      observation.region ?? null,
      observation.zone ?? null,
      graceMs,
      observation.metadata ?? {},
    ],
  );
  return rows[0];
}

export async function updateComputeOrphan(
  id: string,
  updates: {
    state?: string;
    stopped_at?: Date | null;
    resolved_at?: Date | null;
    last_error?: string | null;
  },
): Promise<void> {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`);
  await getPool().query(
    `UPDATE compute_vm_orphans SET ${assignments.join(", ")} WHERE id=$1`,
    [id, ...entries.map(([, value]) => value)],
  );
}

export async function resolveAbsentComputeOrphans(
  observedIds: string[],
  resourceTypes: ComputeOrphanResourceType[],
): Promise<void> {
  await getPool().query(
    `UPDATE compute_vm_orphans
        SET state=CASE WHEN state='deleted' THEN state ELSE 'resolved' END,
            resolved_at=COALESCE(resolved_at,NOW()), last_error=NULL
      WHERE resolved_at IS NULL
        AND resource_type = ANY($2::text[])
        AND NOT (id = ANY($1::text[]))`,
    [observedIds, resourceTypes],
  );
}

export async function listComputeOrphans(
  opts: {
    include_resolved?: boolean;
  } = {},
): Promise<ComputeOrphanRow[]> {
  const { rows } = await getPool().query<ComputeOrphanRow>(
    `SELECT * FROM compute_vm_orphans
      ${opts.include_resolved ? "" : "WHERE resolved_at IS NULL"}
      ORDER BY first_seen_at, id`,
  );
  return rows;
}
