/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type {
  HostRehomeAcceptRequest,
  HostRehomeLogRequest,
  HostRehomePrepareRequest,
  HostRehomePrepareResponse,
  HostRehomeReconnectRequest,
  HostRehomeResponse as InterBayHostRehomeResponse,
} from "@cocalc/conat/inter-bay/api";
import type {
  HostOwnerSshTrustResult,
  HostRehomeOperationStage,
  HostRehomeOperationStatus,
  HostRehomeOperationSummary,
  HostRehomeResponse,
} from "@cocalc/conat/hub/api/hosts";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { logCloudVmEvent } from "@cocalc/server/cloud";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import {
  assertCloudHostBootstrapReconcileSupported,
  reconcileCloudHostBootstrapOverSsh,
  trustHostOwnerBaySshKeyForHostRow,
} from "@cocalc/server/conat/api/hosts-bootstrap-reconcile";
import { notifyProjectHostUpdate } from "@cocalc/server/conat/route-project";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  resolveHostBay,
  resolveHostBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { getRoutedHostControlClient } from "./client";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:project-host:rehome");
const HOST_REHOME_OPERATIONS_TABLE = "project_host_rehome_operations";
const HOST_REHOME_TIMEOUT_MS = 25 * 60_000;

type HostRehomeOperationRow = HostRehomeOperationSummary & {
  host: Record<string, unknown> | null;
};

let hostRehomeSchemaReady: Promise<void> | undefined;

function normalizeUuid(name: string, value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw new Error(`${name} must be a uuid`);
  }
  return normalized;
}

function normalizeBayId(name: string, value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw new Error(`${name} must be specified`);
  }
  return normalized;
}

function requireAccount(account_id?: string): string {
  if (!account_id) {
    throw new Error("must be signed in to rehome hosts");
  }
  return account_id;
}

async function assertAdmin(account_id?: string): Promise<string> {
  const accountId = requireAccount(account_id);
  if (!(await isAdmin(accountId))) {
    throw new Error("not authorized");
  }
  return accountId;
}

async function assertBayExists(bay_id: string): Promise<void> {
  const localBayId = getConfiguredBayId();
  if (bay_id === localBayId) {
    return;
  }
  const entries = await listClusterBayRegistry();
  if (!entries.some((entry) => entry.bay_id === bay_id)) {
    throw new Error(`bay ${bay_id} not found`);
  }
}

async function ensureHostRehomeSchema(): Promise<void> {
  hostRehomeSchemaReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${HOST_REHOME_OPERATIONS_TABLE} (
        op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        source_bay_id TEXT NOT NULL,
        dest_bay_id TEXT NOT NULL,
        requested_by UUID,
        reason TEXT,
        campaign_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        stage TEXT NOT NULL DEFAULT 'requested',
        attempt INTEGER NOT NULL DEFAULT 0,
        host JSONB,
        last_error TEXT,
        destination_prepared_at TIMESTAMPTZ,
        destination_accepted_at TIMESTAMPTZ,
        source_flipped_at TIMESTAMPTZ,
        host_reconnected_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_host_rehome_operations_host_idx ON ${HOST_REHOME_OPERATIONS_TABLE}(host_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_host_rehome_operations_source_idx ON ${HOST_REHOME_OPERATIONS_TABLE}(source_bay_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_host_rehome_operations_campaign_idx ON ${HOST_REHOME_OPERATIONS_TABLE}(campaign_id)`,
    );
  })();
  await hostRehomeSchemaReady;
}

function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(`${value}`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? date.toISOString() : undefined;
}

function durationMs(
  row: Pick<HostRehomeOperationRow, "created_at" | "finished_at">,
): number | undefined {
  const created = toIso(row.created_at);
  const finished = toIso(row.finished_at);
  if (!created || !finished) return undefined;
  const duration = new Date(finished).getTime() - new Date(created).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function summarizeOperation(
  row: HostRehomeOperationRow,
): HostRehomeOperationSummary {
  return {
    op_id: row.op_id,
    host_id: row.host_id,
    source_bay_id: row.source_bay_id,
    dest_bay_id: row.dest_bay_id,
    requested_by: row.requested_by ?? null,
    reason: row.reason ?? null,
    campaign_id: row.campaign_id ?? null,
    status: row.status,
    stage: row.stage,
    attempt: Number(row.attempt) || 0,
    last_error: row.last_error ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    finished_at: toIso(row.finished_at) ?? null,
    duration_ms: durationMs(row),
  };
}

async function loadHostRowForRehome(
  host_id: string,
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `
      SELECT id, bay_id, name, region, public_url, internal_url, ssh_server,
             status, last_seen, version, capacity, metadata, starred_by,
             tier, created, updated, deleted
        FROM project_hosts
       WHERE id = $1
         AND deleted IS NULL
       LIMIT 1
    `,
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host ${host_id} not found`);
  }
  return row;
}

async function upsertHostRowForRehome({
  host,
  dest_bay_id,
}: {
  host: Record<string, unknown>;
  dest_bay_id: string;
}): Promise<void> {
  await getPool().query(
    `
      INSERT INTO project_hosts
        (id, bay_id, name, region, public_url, internal_url, ssh_server,
         status, last_seen, version, capacity, metadata, starred_by,
         tier, created, updated, deleted)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO UPDATE SET
        bay_id = EXCLUDED.bay_id,
        name = EXCLUDED.name,
        region = EXCLUDED.region,
        public_url = EXCLUDED.public_url,
        internal_url = EXCLUDED.internal_url,
        ssh_server = EXCLUDED.ssh_server,
        status = EXCLUDED.status,
        last_seen = EXCLUDED.last_seen,
        version = EXCLUDED.version,
        capacity = EXCLUDED.capacity,
        metadata = EXCLUDED.metadata,
        starred_by = EXCLUDED.starred_by,
        tier = EXCLUDED.tier,
        updated = NOW(),
        deleted = EXCLUDED.deleted
      WHERE project_hosts.deleted IS NULL
    `,
    [
      host.id,
      dest_bay_id,
      host.name ?? null,
      host.region ?? null,
      host.public_url ?? null,
      host.internal_url ?? null,
      host.ssh_server ?? null,
      host.status ?? null,
      host.last_seen ?? null,
      host.version ?? null,
      host.capacity ?? null,
      host.metadata ?? {},
      host.starred_by ?? [],
      host.tier ?? null,
      host.created ?? new Date(),
      host.updated ?? new Date(),
      host.deleted ?? null,
    ],
  );
}

async function createOperation({
  host_id,
  source_bay_id,
  dest_bay_id,
  account_id,
  reason,
  campaign_id,
}: {
  host_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  account_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<HostRehomeOperationRow> {
  await ensureHostRehomeSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `host-rehome:${host_id}`,
    ]);
    const active = await client.query<HostRehomeOperationRow>(
      `
        SELECT *
          FROM ${HOST_REHOME_OPERATIONS_TABLE}
         WHERE host_id = $1
           AND status = 'running'
         ORDER BY created_at DESC
         LIMIT 1
      `,
      [host_id],
    );
    const existing = active.rows[0];
    if (existing) {
      if (
        existing.source_bay_id === source_bay_id &&
        existing.dest_bay_id === dest_bay_id
      ) {
        await client.query("COMMIT");
        return existing;
      }
      throw new Error(
        `host ${host_id} already has running rehome operation ${existing.op_id} from ${existing.source_bay_id} to ${existing.dest_bay_id}`,
      );
    }
    const { rows } = await client.query<HostRehomeOperationRow>(
      `
        INSERT INTO ${HOST_REHOME_OPERATIONS_TABLE}
          (host_id, source_bay_id, dest_bay_id, requested_by, reason, campaign_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        host_id,
        source_bay_id,
        dest_bay_id,
        account_id,
        reason ?? null,
        campaign_id ?? null,
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

export async function getHostRehomeOperation(
  op_id: string,
): Promise<HostRehomeOperationSummary | undefined> {
  await ensureHostRehomeSchema();
  const { rows } = await getPool().query<HostRehomeOperationRow>(
    `SELECT * FROM ${HOST_REHOME_OPERATIONS_TABLE} WHERE op_id = $1`,
    [op_id],
  );
  const row = rows[0];
  return row ? summarizeOperation(row) : undefined;
}

async function updateOperation({
  op_id,
  status,
  stage,
  host,
  last_error,
}: {
  op_id: string;
  status?: HostRehomeOperationStatus;
  stage?: HostRehomeOperationStage;
  host?: Record<string, unknown> | null;
  last_error?: string | null;
}): Promise<HostRehomeOperationRow> {
  await ensureHostRehomeSchema();
  const sets = ["updated_at = NOW()"];
  const values: any[] = [op_id];
  let i = 2;
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(status);
    if (status === "succeeded" || status === "failed") {
      sets.push("finished_at = NOW()");
    }
    if (status === "running") {
      sets.push("finished_at = NULL");
    }
  }
  if (stage !== undefined) {
    sets.push(`stage = $${i++}`);
    values.push(stage);
    if (stage === "destination_prepared") {
      sets.push(
        "destination_prepared_at = COALESCE(destination_prepared_at, NOW())",
      );
    } else if (stage === "destination_accepted") {
      sets.push(
        "destination_accepted_at = COALESCE(destination_accepted_at, NOW())",
      );
    } else if (stage === "source_flipped") {
      sets.push("source_flipped_at = COALESCE(source_flipped_at, NOW())");
    } else if (stage === "host_reconnected") {
      sets.push("host_reconnected_at = COALESCE(host_reconnected_at, NOW())");
    }
  }
  if (host !== undefined) {
    sets.push(`host = $${i++}`);
    values.push(host);
  }
  if (last_error !== undefined) {
    sets.push(`last_error = $${i++}`);
    values.push(last_error);
  }
  const { rows } = await getPool().query<HostRehomeOperationRow>(
    `
      UPDATE ${HOST_REHOME_OPERATIONS_TABLE}
         SET ${sets.join(", ")}
       WHERE op_id = $1
       RETURNING *
    `,
    values,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host rehome operation ${op_id} not found`);
  }
  return row;
}

async function startAttempt(op_id: string): Promise<HostRehomeOperationRow> {
  await ensureHostRehomeSchema();
  const { rows } = await getPool().query<HostRehomeOperationRow>(
    `
      UPDATE ${HOST_REHOME_OPERATIONS_TABLE}
         SET attempt = attempt + 1,
             status = 'running',
             last_error = NULL,
             finished_at = NULL,
             updated_at = NOW()
       WHERE op_id = $1
       RETURNING *
    `,
    [op_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host rehome operation ${op_id} not found`);
  }
  return row;
}

async function markFailed({
  op_id,
  err,
}: {
  op_id: string;
  err: unknown;
}): Promise<HostRehomeOperationRow> {
  return await updateOperation({
    op_id,
    status: "failed",
    last_error: err instanceof Error ? err.message : `${err}`,
  });
}

async function flipSourceOwnershipIfNeeded({
  host_id,
  dest_bay_id,
}: {
  host_id: string;
  dest_bay_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
      UPDATE project_hosts
         SET bay_id = $2,
             updated = NOW()
       WHERE id = $1
         AND deleted IS NULL
         AND COALESCE(bay_id, '') IS DISTINCT FROM $2
    `,
    [host_id, dest_bay_id],
  );
  if ((rowCount ?? 0) > 0) {
    await notifyProjectHostUpdate({ host_id });
  }
}

async function writeHostRehomeLog({
  host_id,
  op_id,
  source_bay_id,
  dest_bay_id,
  requested_by,
  reason,
  campaign_id,
  duration_ms,
}: HostRehomeLogRequest): Promise<void> {
  await logCloudVmEvent({
    vm_id: host_id,
    action: "rehome",
    status: "success",
    spec: {
      op_id,
      source_bay_id,
      dest_bay_id,
      requested_by: requested_by ?? null,
      reason: reason ?? null,
      campaign_id: campaign_id ?? null,
      duration_ms: duration_ms ?? null,
    },
  });
}

async function appendHostRehomeLogEntry(
  op: HostRehomeOperationRow,
): Promise<void> {
  const entry: HostRehomeLogRequest = {
    host_id: op.host_id,
    op_id: op.op_id,
    source_bay_id: op.source_bay_id,
    dest_bay_id: op.dest_bay_id,
    requested_by: op.requested_by ?? null,
    reason: op.reason ?? null,
    campaign_id: op.campaign_id ?? null,
    duration_ms: durationMs(op) ?? null,
  };
  const localBayId = getConfiguredBayId();
  if (op.dest_bay_id === localBayId) {
    await writeHostRehomeLog(entry);
    return;
  }
  try {
    await getInterBayBridge()
      .hostConnection(op.dest_bay_id, {
        timeout_ms: HOST_REHOME_TIMEOUT_MS,
      })
      .recordHostRehomeLog(entry);
  } catch (err) {
    log.warn("host rehome destination log entry write failed", {
      op_id: op.op_id,
      host_id: op.host_id,
      source_bay_id: op.source_bay_id,
      dest_bay_id: op.dest_bay_id,
      err: `${err}`,
    });
    await writeHostRehomeLog(entry);
  }
}

export async function prepareHostRehomeOnDestination({
  host_id,
  source_bay_id,
  dest_bay_id,
  host,
}: HostRehomePrepareRequest): Promise<HostRehomePrepareResponse> {
  const hostId = normalizeUuid("host_id", host_id);
  const sourceBayId = normalizeBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `host rehome prepare for ${hostId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  let ownerBayPublicKeyInstalled = false;
  let ownerBayPublicKeyTrustedByCloud = false;
  if (host != null) {
    const result = await trustHostOwnerBaySshKeyForHostRow({
      host_id: hostId,
      row: host,
    });
    ownerBayPublicKeyTrustedByCloud = result.cloud_provider_succeeded;
    ownerBayPublicKeyInstalled =
      result.host_control_succeeded || result.cloud_provider_succeeded;
  }
  log.info("host rehome destination prepared", {
    host_id: hostId,
    source_bay_id: sourceBayId,
    dest_bay_id: destBayId,
    owner_bay_public_key_installed: ownerBayPublicKeyInstalled,
    owner_bay_public_key_trusted_by_cloud: ownerBayPublicKeyTrustedByCloud,
  });
  return {
    host_id: hostId,
    dest_bay_id: destBayId,
    owner_bay_public_key_installed: ownerBayPublicKeyInstalled,
    owner_bay_public_key_trusted_by_cloud: ownerBayPublicKeyTrustedByCloud,
  };
}

export async function acceptHostRehome({
  host_id,
  source_bay_id,
  dest_bay_id,
  host,
}: HostRehomeAcceptRequest): Promise<InterBayHostRehomeResponse> {
  const hostId = normalizeUuid("host_id", host_id);
  const sourceBayId = normalizeBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `host rehome accept for ${hostId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  const payloadHostId = normalizeUuid("host.id", `${host?.id ?? ""}`);
  if (payloadHostId !== hostId) {
    throw new Error(
      `host rehome payload host id ${payloadHostId} does not match ${hostId}`,
    );
  }
  await upsertHostRowForRehome({
    host,
    dest_bay_id: destBayId,
  });
  await notifyProjectHostUpdate({ host_id: hostId });
  return {
    host_id: hostId,
    previous_bay_id: sourceBayId,
    owning_bay_id: destBayId,
    status: sourceBayId === destBayId ? "already-home" : "rehomed",
  };
}

export async function reconnectHostRehomeOnDestination({
  host_id,
  source_bay_id,
  dest_bay_id,
}: HostRehomeReconnectRequest): Promise<void> {
  const hostId = normalizeUuid("host_id", host_id);
  const sourceBayId = normalizeBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `host rehome reconnect for ${hostId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  const row = await loadHostRowForRehome(hostId);
  assertCloudHostBootstrapReconcileSupported(row);
  await reconcileCloudHostBootstrapOverSsh({ host_id: hostId, row });
  log.info("host rehome destination reconnected", {
    host_id: hostId,
    source_bay_id: sourceBayId,
    dest_bay_id: destBayId,
  });
}

export async function recordHostRehomeLogOnDestination(
  req: HostRehomeLogRequest,
): Promise<void> {
  const hostId = normalizeUuid("host_id", req.host_id);
  const destBayId = normalizeBayId("dest_bay_id", req.dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `host rehome log for ${hostId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  await writeHostRehomeLog({
    ...req,
    host_id: hostId,
    source_bay_id: normalizeBayId("source_bay_id", req.source_bay_id),
    dest_bay_id: destBayId,
  });
}

export async function rehomeHostOnOwningBay({
  account_id,
  host_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id: string;
  host_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<HostRehomeResponse> {
  const hostId = normalizeUuid("host_id", host_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  const ownership = await resolveHostBayDirect(hostId);
  if (ownership == null || ownership.bay_id !== localBayId) {
    throw new Error(`host ${hostId} is not owned by local bay ${localBayId}`);
  }
  if (destBayId === localBayId) {
    return {
      host_id: hostId,
      previous_bay_id: localBayId,
      owning_bay_id: localBayId,
      status: "already-home",
    };
  }
  await assertBayExists(destBayId);
  const op = await createOperation({
    host_id: hostId,
    source_bay_id: localBayId,
    dest_bay_id: destBayId,
    account_id,
    reason,
    campaign_id,
  });
  return await runHostRehomeOperation(op.op_id);
}

export async function runHostRehomeOperation(
  op_id: string,
): Promise<HostRehomeResponse> {
  let op = await startAttempt(op_id);
  const localBayId = getConfiguredBayId();
  if (op.source_bay_id !== localBayId) {
    throw new Error(
      `host rehome operation ${op_id} belongs to source bay ${op.source_bay_id}, not local bay ${localBayId}`,
    );
  }

  try {
    if (op.dest_bay_id === op.source_bay_id) {
      op = await updateOperation({
        op_id,
        status: "succeeded",
        stage: "complete",
      });
      return {
        op_id,
        host_id: op.host_id,
        previous_bay_id: op.source_bay_id,
        owning_bay_id: op.dest_bay_id,
        operation_stage: op.stage,
        operation_status: op.status,
        status: "already-home",
      };
    }

    let host = op.host;
    if (!host) {
      host = await loadHostRowForRehome(op.host_id);
      op = await updateOperation({ op_id, host });
    }

    if (op.stage === "requested") {
      await getInterBayBridge()
        .hostConnection(op.dest_bay_id, {
          timeout_ms: HOST_REHOME_TIMEOUT_MS,
        })
        .prepareHostRehome({
          host_id: op.host_id,
          source_bay_id: op.source_bay_id,
          dest_bay_id: op.dest_bay_id,
          host: host ?? op.host ?? {},
        });
      op = await updateOperation({
        op_id,
        stage: "destination_prepared",
      });
    }

    if (op.stage === "destination_prepared") {
      await getInterBayBridge()
        .hostConnection(op.dest_bay_id, {
          timeout_ms: HOST_REHOME_TIMEOUT_MS,
        })
        .acceptHostRehome({
          host_id: op.host_id,
          source_bay_id: op.source_bay_id,
          dest_bay_id: op.dest_bay_id,
          host: host ?? op.host ?? {},
        });
      op = await updateOperation({
        op_id,
        stage: "destination_accepted",
      });
    }

    if (op.stage === "destination_accepted") {
      await flipSourceOwnershipIfNeeded({
        host_id: op.host_id,
        dest_bay_id: op.dest_bay_id,
      });
      op = await updateOperation({
        op_id,
        stage: "source_flipped",
      });
    }

    if (op.stage === "source_flipped") {
      await getInterBayBridge()
        .hostConnection(op.dest_bay_id, {
          timeout_ms: HOST_REHOME_TIMEOUT_MS,
        })
        .reconnectHostRehome({
          host_id: op.host_id,
          source_bay_id: op.source_bay_id,
          dest_bay_id: op.dest_bay_id,
        });
      const client = await getRoutedHostControlClient({
        host_id: op.host_id,
        timeout: HOST_REHOME_TIMEOUT_MS,
        fresh: true,
      });
      await client.getHostAgentStatus();
      op = await updateOperation({
        op_id,
        stage: "host_reconnected",
      });
    }

    if (op.stage === "host_reconnected") {
      op = await updateOperation({
        op_id,
        status: "succeeded",
        stage: "complete",
      });
      try {
        await appendHostRehomeLogEntry(op);
      } catch (err) {
        log.warn("host rehome log entry write failed", {
          op_id,
          host_id: op.host_id,
          source_bay_id: op.source_bay_id,
          dest_bay_id: op.dest_bay_id,
          err: `${err}`,
        });
      }
    }

    log.info("host rehomed", {
      op_id,
      host_id: op.host_id,
      previous_bay_id: op.source_bay_id,
      owning_bay_id: op.dest_bay_id,
      stage: op.stage,
    });
    return {
      op_id,
      host_id: op.host_id,
      previous_bay_id: op.source_bay_id,
      owning_bay_id: op.dest_bay_id,
      operation_stage: op.stage,
      operation_status: op.status,
      status: "rehomed",
    };
  } catch (err) {
    const failed = await markFailed({ op_id, err });
    log.warn("host rehome failed", {
      op_id,
      host_id: failed.host_id,
      source_bay_id: failed.source_bay_id,
      dest_bay_id: failed.dest_bay_id,
      stage: failed.stage,
      err: `${err}`,
    });
    throw err;
  }
}

export async function rehomeHost({
  account_id,
  host_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id?: string;
  host_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<HostRehomeResponse> {
  const accountId = await assertAdmin(account_id);
  const hostId = normalizeUuid("host_id", host_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  await assertBayExists(destBayId);
  const ownership = await resolveHostBay(hostId);
  if (ownership == null) {
    throw new Error(`host ${hostId} not found`);
  }
  const localBayId = getConfiguredBayId();
  if (ownership.bay_id !== localBayId) {
    return await getInterBayBridge()
      .hostConnection(ownership.bay_id, {
        timeout_ms: HOST_REHOME_TIMEOUT_MS,
      })
      .rehomeHost({
        account_id: accountId,
        host_id: hostId,
        dest_bay_id: destBayId,
        reason,
        campaign_id,
        epoch: ownership.epoch,
      });
  }
  return await rehomeHostOnOwningBay({
    account_id: accountId,
    host_id: hostId,
    dest_bay_id: destBayId,
    reason,
    campaign_id,
  });
}

export async function ensureHostOwnerSshTrustOnBay({
  account_id,
  host_id,
  host,
}: {
  account_id?: string;
  host_id: string;
  host?: Record<string, unknown>;
}): Promise<HostOwnerSshTrustResult> {
  await assertAdmin(account_id);
  const hostId = normalizeUuid("host_id", host_id);
  const row = host ?? (await loadHostRowForRehome(hostId));
  const result = await trustHostOwnerBaySshKeyForHostRow({
    host_id: hostId,
    row,
  });
  return {
    host_id: hostId,
    bay_id: getConfiguredBayId(),
    ...result,
  };
}

export async function ensureHostOwnerSshTrust({
  account_id,
  host_id,
}: {
  account_id?: string;
  host_id: string;
}): Promise<HostOwnerSshTrustResult> {
  const accountId = await assertAdmin(account_id);
  const hostId = normalizeUuid("host_id", host_id);
  const ownership = await resolveHostBay(hostId);
  if (ownership == null) {
    throw new Error(`host ${hostId} not found`);
  }
  const localBayId = getConfiguredBayId();
  if (ownership.bay_id !== localBayId) {
    return await getInterBayBridge()
      .hostConnection(ownership.bay_id, {
        timeout_ms: HOST_REHOME_TIMEOUT_MS,
      })
      .ensureHostOwnerSshTrust({
        account_id: accountId,
        host_id: hostId,
        epoch: ownership.epoch,
      });
  }
  return await ensureHostOwnerSshTrustOnBay({
    account_id: accountId,
    host_id: hostId,
  });
}

export async function reconcileHostRehome({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<HostRehomeResponse> {
  await assertAdmin(account_id);
  return await runHostRehomeOperation(op_id);
}
