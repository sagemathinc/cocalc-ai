import getPool from "@cocalc/database/pool";
import type { Pool } from "pg";
import { recordProjectHostMetricsSample } from "./project-host-metrics";

export interface ProjectHostRecord {
  id: string;
  bay_id?: string;
  name?: string;
  region?: string;
  public_url?: string;
  internal_url?: string;
  ssh_server?: string;
  sshpiperd_public_key?: string;
  status?: string;
  version?: string;
  capacity?: any;
  metadata?: any;
  last_seen?: Date;
  host_session_id?: string;
}

function pool(): Pool {
  return getPool();
}

export async function upsertProjectHost({
  id,
  bay_id,
  name,
  region,
  public_url,
  internal_url,
  ssh_server,
  status,
  version,
  capacity,
  metadata,
  last_seen,
  sshpiperd_public_key,
  host_session_id,
}: ProjectHostRecord): Promise<void> {
  const now = last_seen ?? new Date();
  const mergedMetadata = {
    ...(metadata ?? {}),
    ...(sshpiperd_public_key ? { sshpiperd_public_key } : {}),
    ...(host_session_id ? { host_session_id } : {}),
  };
  await pool().query(
    `
    INSERT INTO project_hosts
      (id, bay_id, name, region, public_url, internal_url, ssh_server, status, version, capacity, metadata, last_seen, created, updated)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      bay_id = COALESCE(EXCLUDED.bay_id, project_hosts.bay_id),
      name = EXCLUDED.name,
      region = EXCLUDED.region,
      public_url = EXCLUDED.public_url,
      internal_url = EXCLUDED.internal_url,
      ssh_server = EXCLUDED.ssh_server,
      status = COALESCE(EXCLUDED.status, project_hosts.status),
      version = EXCLUDED.version,
      capacity = EXCLUDED.capacity,
      metadata = COALESCE(project_hosts.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      last_seen = EXCLUDED.last_seen,
      updated = NOW()
    WHERE project_hosts.deleted IS NULL;
  `,
    [
      id,
      bay_id ?? null,
      name ?? null,
      region ?? null,
      public_url ?? null,
      internal_url ?? null,
      ssh_server ?? null,
      status ?? null,
      version ?? null,
      capacity ?? null,
      mergedMetadata,
      now,
    ],
  );
  await recordProjectHostMetricsSample({
    host_id: id,
    metrics: metadata?.metrics?.current,
  });
}
