/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  HostRuntimeDeploymentRecord,
  HostRuntimeDeploymentScopeType,
  HostRuntimeDeploymentUpsert,
} from "@cocalc/conat/hub/api/hosts";
import type { Pool, PoolClient } from "pg";

let schemaReady: Promise<void> | undefined;

type ProjectHostRuntimeDeploymentRow = {
  scope_type: HostRuntimeDeploymentScopeType;
  scope_id: string;
  host_id: string | null;
  target_type: "component" | "artifact";
  target: string;
  desired_version: string;
  rollout_policy: string | null;
  drain_deadline_seconds: number | string | null;
  rollout_reason: string | null;
  requested_by: string;
  requested_at: Date | string;
  updated_at: Date | string;
  metadata: Record<string, any> | null;
};

function pool(): Pool {
  return getPool();
}

function normalizeTimestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function toInteger(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function scopeIdOf({
  scope_type,
  host_id,
}: {
  scope_type: HostRuntimeDeploymentScopeType;
  host_id?: string;
}): string {
  if (scope_type === "global") return "global";
  if (!host_id?.trim()) {
    throw new Error("host id is required for host runtime deployment scope");
  }
  return host_id;
}

function normalizeRecord(
  row: ProjectHostRuntimeDeploymentRow,
): HostRuntimeDeploymentRecord {
  return {
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    host_id: row.host_id ?? undefined,
    target_type: row.target_type,
    target: row.target as HostRuntimeDeploymentRecord["target"],
    desired_version: row.desired_version,
    rollout_policy:
      (row.rollout_policy as HostRuntimeDeploymentRecord["rollout_policy"]) ??
      undefined,
    drain_deadline_seconds: toInteger(row.drain_deadline_seconds),
    rollout_reason: row.rollout_reason ?? undefined,
    requested_by: row.requested_by,
    requested_at: normalizeTimestamp(row.requested_at),
    updated_at: normalizeTimestamp(row.updated_at),
    metadata: row.metadata ?? undefined,
  };
}

function recordSortKey(
  record: Pick<
    HostRuntimeDeploymentRecord,
    "target_type" | "target" | "scope_type"
  >,
): string {
  return `${record.target_type}:${record.target}:${record.scope_type}`;
}

function sortRecords(
  records: HostRuntimeDeploymentRecord[],
): HostRuntimeDeploymentRecord[] {
  return [...records].sort((left, right) =>
    recordSortKey(left).localeCompare(recordSortKey(right)),
  );
}

function targetKey({
  target_type,
  target,
}: Pick<HostRuntimeDeploymentUpsert, "target_type" | "target">): string {
  return `${target_type}:${target}`;
}

function normalizeDeployments(
  deployments: HostRuntimeDeploymentUpsert[],
): HostRuntimeDeploymentUpsert[] {
  const deduped = new Map<string, HostRuntimeDeploymentUpsert>();
  for (const deployment of deployments ?? []) {
    const desiredVersion = `${deployment?.desired_version ?? ""}`.trim();
    if (!desiredVersion) continue;
    const targetType = deployment?.target_type;
    const target = `${deployment?.target ?? ""}`.trim();
    if ((targetType !== "component" && targetType !== "artifact") || !target) {
      continue;
    }
    const normalizedTarget = target as HostRuntimeDeploymentUpsert["target"];
    deduped.set(
      targetKey({ target_type: targetType, target: normalizedTarget }),
      {
        ...deployment,
        target_type: targetType,
        target: normalizedTarget,
        desired_version: desiredVersion,
        rollout_reason:
          `${deployment?.rollout_reason ?? ""}`.trim() || undefined,
        metadata:
          deployment?.metadata && typeof deployment.metadata === "object"
            ? deployment.metadata
            : undefined,
        drain_deadline_seconds: toInteger(deployment?.drain_deadline_seconds),
      },
    );
  }
  return [...deduped.values()];
}

async function selectScopeRows(
  client: Pool | PoolClient,
  {
    scope_type,
    host_id,
  }: {
    scope_type: HostRuntimeDeploymentScopeType;
    host_id?: string;
  },
): Promise<HostRuntimeDeploymentRecord[]> {
  const scope_id = scopeIdOf({ scope_type, host_id });
  const params: any[] = [scope_type, scope_id];
  let query = `
    SELECT
      scope_type,
      scope_id,
      host_id,
      target_type,
      target,
      desired_version,
      rollout_policy,
      drain_deadline_seconds,
      rollout_reason,
      requested_by,
      requested_at,
      updated_at,
      metadata
    FROM project_host_runtime_deployments
    WHERE scope_type=$1 AND scope_id=$2
  `;
  if (scope_type === "global") {
    query += " AND host_id IS NULL";
  } else {
    params.push(host_id);
    query += " AND host_id=$3";
  }
  query += " ORDER BY target_type, target";
  const { rows } = await client.query<ProjectHostRuntimeDeploymentRow>(
    query,
    params,
  );
  return sortRecords(rows.map(normalizeRecord));
}

export async function ensureProjectHostRuntimeDeploymentsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_host_runtime_deployments (
          scope_type TEXT NOT NULL
            CHECK (scope_type IN ('global', 'host')),
          scope_id TEXT NOT NULL,
          host_id UUID REFERENCES project_hosts(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL
            CHECK (target_type IN ('component', 'artifact')),
          target TEXT NOT NULL,
          desired_version TEXT NOT NULL,
          rollout_policy TEXT,
          drain_deadline_seconds INTEGER,
          rollout_reason TEXT,
          requested_by TEXT NOT NULL,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          PRIMARY KEY (scope_type, scope_id, target_type, target),
          CHECK (
            (scope_type = 'global' AND scope_id = 'global' AND host_id IS NULL)
            OR (scope_type = 'host' AND host_id IS NOT NULL)
          )
        )
      `);
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_host_runtime_deployments_host_idx ON project_host_runtime_deployments(host_id, target_type, target)",
      );
    })().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  await schemaReady;
}

export async function listProjectHostRuntimeDeployments({
  scope_type,
  host_id,
}: {
  scope_type: HostRuntimeDeploymentScopeType;
  host_id?: string;
}): Promise<HostRuntimeDeploymentRecord[]> {
  await ensureProjectHostRuntimeDeploymentsSchema();
  return await selectScopeRows(pool(), { scope_type, host_id });
}

export async function setProjectHostRuntimeDeployments({
  scope_type,
  host_id,
  deployments,
  requested_by,
  replace,
}: {
  scope_type: HostRuntimeDeploymentScopeType;
  host_id?: string;
  deployments: HostRuntimeDeploymentUpsert[];
  requested_by: string;
  replace?: boolean;
}): Promise<HostRuntimeDeploymentRecord[]> {
  await ensureProjectHostRuntimeDeploymentsSchema();
  const scope_id = scopeIdOf({ scope_type, host_id });
  const normalized = normalizeDeployments(deployments);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (replace) {
      await client.query(
        `
          DELETE FROM project_host_runtime_deployments
          WHERE scope_type=$1 AND scope_id=$2
        `,
        [scope_type, scope_id],
      );
    }
    for (const deployment of normalized) {
      await client.query(
        `
          INSERT INTO project_host_runtime_deployments (
            scope_type,
            scope_id,
            host_id,
            target_type,
            target,
            desired_version,
            rollout_policy,
            drain_deadline_seconds,
            rollout_reason,
            requested_by,
            requested_at,
            updated_at,
            metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW(),$11::jsonb)
          ON CONFLICT (scope_type, scope_id, target_type, target)
          DO UPDATE SET
            host_id = EXCLUDED.host_id,
            desired_version = EXCLUDED.desired_version,
            rollout_policy = EXCLUDED.rollout_policy,
            drain_deadline_seconds = EXCLUDED.drain_deadline_seconds,
            rollout_reason = EXCLUDED.rollout_reason,
            requested_by = EXCLUDED.requested_by,
            requested_at = EXCLUDED.requested_at,
            updated_at = NOW(),
            metadata = EXCLUDED.metadata
        `,
        [
          scope_type,
          scope_id,
          scope_type === "host" ? host_id : null,
          deployment.target_type,
          deployment.target,
          deployment.desired_version,
          deployment.rollout_policy ?? null,
          deployment.drain_deadline_seconds ?? null,
          deployment.rollout_reason ?? null,
          requested_by,
          JSON.stringify(deployment.metadata ?? {}),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return await listProjectHostRuntimeDeployments({ scope_type, host_id });
}

export async function loadEffectiveProjectHostRuntimeDeployments({
  host_id,
}: {
  host_id: string;
}): Promise<HostRuntimeDeploymentRecord[]> {
  await ensureProjectHostRuntimeDeploymentsSchema();
  const [globalRows, hostRows] = await Promise.all([
    listProjectHostRuntimeDeployments({ scope_type: "global" }),
    listProjectHostRuntimeDeployments({ scope_type: "host", host_id }),
  ]);
  const merged = new Map<string, HostRuntimeDeploymentRecord>();
  for (const record of globalRows) {
    merged.set(targetKey(record), record);
  }
  for (const record of hostRows) {
    merged.set(targetKey(record), record);
  }
  return sortRecords([...merged.values()]);
}
