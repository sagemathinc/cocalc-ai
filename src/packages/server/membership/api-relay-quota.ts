/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  ApiRelayUsageRequest,
  ApiRelayAllowance,
} from "@cocalc/conat/project-host/api-relay";
import { isValidUUID } from "@cocalc/util/misc";
import { ensureAccountUsageWindowsForEvent } from "./usage-windows";
import { ensureAccountUsageCounterSchema } from "./usage-counters";
import { initializeManagedEgressCounters } from "./managed-egress";
import { resolveMembershipForAccount } from "./resolve";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";

const BLOCK_BYTES = 4 * 1024 * 1024;
const LEASE_MS = 60_000;
const METRIC = "managed-egress-bytes";
const TABLE = "account_api_relay_leases";
let schema: Promise<void> | undefined;
let updates = 0;

export type RelayQuotaRequest = ApiRelayUsageRequest & {
  host_id: string;
  account_id: string;
};
type Lease = {
  host_id: string;
  project_id: string;
  account_id: string;
  sequence: number;
  request_hash: string;
  sent: number;
  received: number;
  allowance: number;
  window_ids: string[];
  category: string;
  target: string;
  closed: boolean;
  reply: ApiRelayAllowance;
};

export function validateRelayUsage(opts: ApiRelayUsageRequest): void {
  if (
    !isValidUUID(opts.project_id) ||
    !isValidUUID(opts.session_id) ||
    ![opts.sequence, opts.sent, opts.received, opts.sent + opts.received].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !["http", "websocket"].includes(opts.transport) ||
    typeof opts.target !== "string" ||
    opts.target.length > 2048 ||
    (opts.close != null && typeof opts.close !== "boolean") ||
    (opts.reason != null &&
      (typeof opts.reason !== "string" || opts.reason.length > 100))
  ) {
    throw Error("invalid API relay usage update");
  }
}

async function ensureSchema(): Promise<void> {
  schema ??= (async () => {
    await ensureAccountUsageCounterSchema();
    await getPool().query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_updated_idx ON ${TABLE}(updated_at)`,
    );
  })().catch((err) => {
    schema = undefined;
    throw err;
  });
  await schema;
}

async function adjustCounters(
  client: PoolClient,
  ids: string[],
  category: string,
  amount: number,
) {
  if (!amount || !ids.length) return;
  await client.query(
    `INSERT INTO account_usage_counters (usage_window_id, metric, category, amount)
    SELECT id, $2, $3, $4 FROM unnest($1::uuid[]) AS id
    ON CONFLICT (usage_window_id, metric, category) DO UPDATE SET
      amount = account_usage_counters.amount + EXCLUDED.amount, updated_at = now()`,
    [ids, METRIC, category, amount],
  );
}

// Called only on the usage account's home bay, after the project-owning bay
// verifies source placement and derives attribution. No caller-selected payer.
export async function updateApiRelayQuota(
  opts: RelayQuotaRequest,
): Promise<ApiRelayAllowance> {
  validateRelayUsage(opts);
  if (!isValidUUID(opts.account_id) || !isValidUUID(opts.host_id))
    throw Error("invalid relay usage identity");
  await ensureSchema();
  const limits = getEffectiveMembershipUsageLimits(
    await resolveMembershipForAccount(opts.account_id),
  );
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        opts.host_id,
        opts.project_id,
        opts.account_id,
        opts.sequence,
        opts.sent,
        opts.received,
        opts.transport,
        opts.target,
        !!opts.close,
        opts.reason ?? "",
      ]),
    )
    .digest("hex");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [opts.session_id, "api-relay-session"],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [opts.account_id, METRIC],
    );
    const { rows } = await client.query<{ state: Lease }>(
      `SELECT state FROM ${TABLE} WHERE session_id=$1 FOR UPDATE`,
      [opts.session_id],
    );
    const old = rows[0]?.state;
    if (old) {
      if (
        old.host_id !== opts.host_id ||
        old.project_id !== opts.project_id ||
        old.account_id !== opts.account_id ||
        old.category !==
          (opts.transport === "http" ? "http-proxy" : "ws-proxy") ||
        old.target !== opts.target
      ) {
        throw Error("API relay lease identity changed");
      }
      if (opts.sequence === old.sequence && old.request_hash === hash) {
        await client.query("COMMIT");
        return old.reply;
      }
      if (
        old.closed ||
        opts.sequence !== old.sequence + 1 ||
        opts.sent < old.sent ||
        opts.received < old.received ||
        opts.sent + opts.received > old.allowance
      ) {
        throw Error("invalid API relay lease sequence or usage");
      }
    } else if (opts.sequence !== 0 || opts.sent !== 0 || opts.received !== 0) {
      throw Error("API relay lease must begin with zero usage");
    }

    const category = opts.transport === "http" ? "http-proxy" : "ws-proxy";
    const used = opts.sent + opts.received;
    if (old) {
      // Reserved bytes already cover everything forwarded since the last update.
      // Return only the known unused balance, in the original usage windows.
      await adjustCounters(
        client,
        old.window_ids,
        category,
        -(old.allowance - used),
      );
    }
    const now = Date.now();
    let grant = 0;
    let expires_at = now;
    let window_ids: string[] = [];
    if (!opts.close) {
      const windows = await ensureAccountUsageWindowsForEvent({
        account_id: opts.account_id,
        client,
      });
      await initializeManagedEgressCounters({
        account_id: opts.account_id,
        windows,
        transaction: client,
      });
      window_ids = Object.values(windows).map(({ id }) => id);
      const usage = await client.query<{
        usage_window_id: string;
        amount: string;
      }>(
        `SELECT usage_window_id, SUM(amount) AS amount FROM account_usage_counters
          WHERE metric=$1 AND usage_window_id = ANY($2::uuid[]) GROUP BY usage_window_id`,
        [METRIC, window_ids],
      );
      const byId = new Map(
        usage.rows.map((r) => [r.usage_window_id, Number(r.amount)]),
      );
      const desired = Math.min(
        BLOCK_BYTES,
        Math.max(64 * 1024, 4 * (used - (old ? old.sent + old.received : 0))),
      );
      grant = Math.max(
        0,
        Math.floor(
          Math.min(
            desired,
            (limits.egress_5h_bytes ?? Infinity) -
              (byId.get(windows["5h"].id) ?? 0),
            (limits.egress_7d_bytes ?? Infinity) -
              (byId.get(windows["7d"].id) ?? 0),
          ),
        ),
      );
      if (!Number.isSafeInteger(grant))
        throw Error("invalid managed egress quota");
      expires_at = Math.min(
        now + LEASE_MS,
        ...Object.values(windows).map((w) => w.resets_at.getTime()),
      );
      await adjustCounters(client, window_ids, category, grant);
    }
    const reply = {
      account_id: opts.account_id,
      allowance: used + grant,
      expires_at,
    };
    const state: Lease = {
      host_id: opts.host_id,
      project_id: opts.project_id,
      account_id: opts.account_id,
      sequence: opts.sequence,
      request_hash: hash,
      sent: opts.sent,
      received: opts.received,
      allowance: reply.allowance,
      window_ids,
      category,
      target: opts.target,
      closed: !!opts.close,
      reply,
    };
    await client.query(
      `INSERT INTO ${TABLE} (session_id, account_id, state) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (session_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
      [opts.session_id, opts.account_id, JSON.stringify(state)],
    );
    const delta = used - (old ? old.sent + old.received : 0);
    // Update the ordinary history/admin rollups without charging counters twice.
    // Keep the last sample so normal completion and its reason are visible too.
    if (delta > 0 || opts.close) {
      await client.query(
        `INSERT INTO account_managed_egress_rollups
        (bucket_start, account_id, project_id, category, bytes, event_count, first_occurred_at, last_occurred_at, metadata_sample)
        VALUES (date_trunc('minute', now()), $1, $2, $3, $4, 1, now(), now(), $5::jsonb)
        ON CONFLICT (bucket_start, account_id, project_id, category) DO UPDATE SET
          bytes=account_managed_egress_rollups.bytes + EXCLUDED.bytes,
          event_count=account_managed_egress_rollups.event_count + 1,
          last_occurred_at=now(), metadata_sample=EXCLUDED.metadata_sample`,
        [
          opts.account_id,
          opts.project_id,
          category,
          delta,
          JSON.stringify({
            source: "api-relay",
            host_id: opts.host_id,
            session_id: opts.session_id,
            target: opts.target,
            sent: opts.sent,
            received: opts.received,
            closed: !!opts.close,
            reason: opts.reason,
          }),
        ],
      );
    }
    if (++updates % 100 === 0) {
      // Old uncertain reservations remain charged until their quota windows end.
      await client.query(`DELETE FROM ${TABLE} WHERE session_id IN
        (SELECT session_id FROM ${TABLE} WHERE updated_at < now() - interval '8 days' LIMIT 100)`);
    }
    await client.query("COMMIT");
    return reply;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
