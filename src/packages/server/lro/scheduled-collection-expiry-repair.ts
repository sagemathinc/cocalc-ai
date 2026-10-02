import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  ScheduledCollectionExpiryRepairRequest,
  ScheduledCollectionExpiryRepairResponse,
} from "@cocalc/conat/hub/api/admin-db";
import { ensureLroSchema } from "./lro-db";

export type TrustedExpiryRepairRequest =
  ScheduledCollectionExpiryRepairRequest & {
    actor_id: string;
  };

function iso(value: unknown): string {
  const date = new Date(value as string);
  if (value == null || !Number.isFinite(date.getTime())) {
    throw new Error("valid scheduled collection timestamps are required");
  }
  return date.toISOString();
}

function reviewedTimestamp(value: string): string {
  iso(value);
  if (typeof value !== "string")
    throw new Error("reviewed timestamps must be strings");
  // Retain PostgreSQL's sub-millisecond precision in the compare-and-swap.
  return value.trim();
}

export function normalizeExpiryRepairRequest(opts: TrustedExpiryRepairRequest) {
  if (![opts.actor_id, opts.project_id, opts.op_id].every(isValidUUID)) {
    throw new Error("valid actor, project and operation IDs are required");
  }
  if (!opts.reason?.trim() || opts.reason.length > 2000) {
    throw new Error("an audit reason of at most 2000 characters is required");
  }
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(opts.idempotency_key ?? "")) {
    throw new Error(
      "a stable idempotency key of at most 128 characters is required",
    );
  }
  if (opts.commit != null && typeof opts.commit !== "boolean") {
    throw new Error("commit must be a boolean");
  }
  return {
    actor_id: opts.actor_id,
    project_id: opts.project_id,
    op_id: opts.op_id,
    expected_updated_at: reviewedTimestamp(opts.expected_updated_at),
    expected_expires_at: reviewedTimestamp(opts.expected_expires_at),
    expected_run_at: reviewedTimestamp(opts.expected_run_at),
    idempotency_key: opts.idempotency_key,
    reason: opts.reason.trim(),
  };
}

// Called only after fresh admin authentication, including on inter-bay dispatch.
export async function repairScheduledCollectionExpiryLocal(
  request: TrustedExpiryRepairRequest,
): Promise<ScheduledCollectionExpiryRepairResponse> {
  const opts = normalizeExpiryRepairRequest(request);
  const hash = createHash("sha256").update(JSON.stringify(opts)).digest("hex");
  await ensureLroSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Serialize retries of one logical request before locking the worker's row.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `scheduled-collection-expiry:${opts.actor_id}:${opts.idempotency_key}`,
    ]);
    const { rows: projects } = await client.query(
      `SELECT COALESCE(owning_bay_id, $2) AS bay_id FROM projects
       WHERE project_id = $1 AND NOT COALESCE(deleted, false) FOR SHARE`,
      [opts.project_id, getConfiguredBayId()],
    );
    if (projects[0]?.bay_id !== getConfiguredBayId()) {
      throw new Error(
        "project is not owned by this bay; resolve ownership again",
      );
    }
    const { rows: receipts } = await client.query(
      `SELECT request_sha256, receipt FROM scheduled_collection_expiry_repairs
       WHERE actor_id = $1 AND idempotency_key = $2`,
      [opts.actor_id, opts.idempotency_key],
    );
    if (receipts.length) {
      if (receipts[0].request_sha256 !== hash) {
        throw new Error(
          "idempotency key was already used for a different request",
        );
      }
      await client.query("ROLLBACK");
      return { ...receipts[0].receipt, replayed: true };
    }
    const { rows } = await client.query(
      `SELECT kind, scope_type, scope_id, status, attempt, started_at,
              finished_at, dismissed_at, routing, updated_at, expires_at,
              input->>'run_at' AS run_at, clock_timestamp() AS server_now,
              updated_at = $2::timestamptz AS matches_updated_at,
              expires_at = $3::timestamptz AS matches_expires_at,
              (input->>'run_at')::timestamptz = $4::timestamptz AS matches_run_at
         FROM long_running_operations WHERE op_id = $1 FOR UPDATE`,
      [
        opts.op_id,
        opts.expected_updated_at,
        opts.expected_expires_at,
        opts.expected_run_at,
      ],
    );
    const row = rows[0];
    if (
      !row ||
      row.kind !== "course-collect-assignment" ||
      row.scope_type !== "project" ||
      row.scope_id !== opts.project_id ||
      row.routing !== "hub" ||
      row.status !== "queued" ||
      row.attempt !== 0 ||
      row.started_at != null ||
      row.finished_at != null ||
      row.dismissed_at != null
    ) {
      throw new Error(
        "only never-started, attempt-zero queued course collections can be repaired",
      );
    }
    const before = {
      updated_at: iso(row.updated_at),
      expires_at: iso(row.expires_at),
      run_at: iso(row.run_at),
    };
    if (
      row.matches_updated_at !== true ||
      row.matches_expires_at !== true ||
      row.matches_run_at !== true
    ) {
      throw new Error(
        "operation changed since review; re-read before repairing",
      );
    }
    const now = new Date(row.server_now).getTime();
    if (
      Date.parse(before.expires_at) <= now ||
      Date.parse(before.run_at) <= now
    ) {
      throw new Error("expired or already-due jobs cannot be repaired");
    }
    const expires_at = new Date(
      Date.parse(before.run_at) + 7 * 86400000,
    ).toISOString();
    if (Date.parse(before.expires_at) >= Date.parse(before.run_at)) {
      throw new Error("expiry is not before the scheduled run time");
    }
    const receipt: ScheduledCollectionExpiryRepairResponse = {
      audit_id: randomUUID(),
      bay_id: getConfiguredBayId(),
      project_id: opts.project_id,
      op_id: opts.op_id,
      committed: request.commit === true,
      replayed: false,
      before,
      after: { ...before, expires_at },
    };
    if (request.commit !== true) {
      await client.query("ROLLBACK");
      return receipt;
    }
    const updated = await client.query(
      `UPDATE long_running_operations SET expires_at = $2, updated_at = clock_timestamp()
       WHERE op_id = $1 AND expires_at > clock_timestamp()
         AND (input->>'run_at')::timestamptz > clock_timestamp()
       RETURNING updated_at, expires_at`,
      [opts.op_id, expires_at],
    );
    if (updated.rows.length !== 1)
      throw new Error("job expired or became due during repair");
    receipt.after.updated_at = iso(updated.rows[0].updated_at);
    receipt.after.expires_at = iso(updated.rows[0].expires_at);
    // The durable audit and idempotency receipt commit atomically with the expiry.
    await client.query(
      `INSERT INTO scheduled_collection_expiry_repairs
       (actor_id, idempotency_key, request_sha256, reason, receipt)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        opts.actor_id,
        opts.idempotency_key,
        hash,
        opts.reason,
        JSON.stringify(receipt),
      ],
    );
    await client.query("COMMIT");
    return receipt;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
