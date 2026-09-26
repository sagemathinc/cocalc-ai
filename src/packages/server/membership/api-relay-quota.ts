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
const ADMISSION_TABLE = "account_api_relay_admission";
export const API_RELAY_QUOTA_LIMITS = {
  startsPerMinute: 120,
  renewalsPerMinute: 1200,
  activeSessions: 128,
  retainedSessions: 2048,
  initialRequestMaxAgeMs: 120_000,
  settledRetentionMs: 5 * 60_000,
  settlementGraceMs: 10 * 60_000,
  cleanupBatch: 1000,
} as const;
let schema: Promise<void> | undefined;

export type RelayQuotaRequest = ApiRelayUsageRequest & {
  host_id: string;
  account_id: string;
};
type Lease = {
  host_id: string;
  project_id: string;
  account_id: string;
  started_at: number;
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
    ![
      opts.started_at,
      opts.sequence,
      opts.sent,
      opts.received,
      opts.sent + opts.received,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
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
    await getPool().query(`ALTER TABLE ${TABLE}
      ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS delete_after timestamptz NOT NULL DEFAULT (now() + interval '11 minutes')`);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_account_idx ON ${TABLE}(account_id)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_gc_idx ON ${TABLE}(delete_after)`,
    );
    await getPool().query(`CREATE TABLE IF NOT EXISTS ${ADMISSION_TABLE} (
      account_id uuid PRIMARY KEY,
      start_tokens double precision NOT NULL,
      renewal_tokens double precision NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${ADMISSION_TABLE}_updated_idx ON ${ADMISSION_TABLE}(updated_at)`,
    );
  })().catch((err) => {
    schema = undefined;
    throw err;
  });
  await schema;
}

// Caller holds the account advisory lock, so these budgets span hosts and hub
// workers. Exhausted attempts are read-only; there is one row per usage account.
async function admitUpdate(
  client: PoolClient,
  accountId: string,
  starting: boolean,
): Promise<void> {
  const now = Date.now();
  const { rows } = await client.query<{
    start_tokens: number;
    renewal_tokens: number;
    updated_at: Date;
  }>(`SELECT * FROM ${ADMISSION_TABLE} WHERE account_id=$1`, [accountId]);
  const old = rows[0];
  const elapsed = old
    ? Math.max(0, now - old.updated_at.getTime()) / 60_000
    : 0;
  let starts = Math.min(
    API_RELAY_QUOTA_LIMITS.startsPerMinute,
    (old?.start_tokens ?? API_RELAY_QUOTA_LIMITS.startsPerMinute) +
      elapsed * API_RELAY_QUOTA_LIMITS.startsPerMinute,
  );
  let renewals = Math.min(
    API_RELAY_QUOTA_LIMITS.renewalsPerMinute,
    (old?.renewal_tokens ?? API_RELAY_QUOTA_LIMITS.renewalsPerMinute) +
      elapsed * API_RELAY_QUOTA_LIMITS.renewalsPerMinute,
  );
  if ((starting ? starts : renewals) < 1) {
    throw Object.assign(Error("account API relay admission rate exceeded"), {
      statusCode: 429,
    });
  }
  if (starting) starts--;
  else renewals--;
  await client.query(
    `INSERT INTO ${ADMISSION_TABLE} (account_id, start_tokens, renewal_tokens, updated_at)
    VALUES ($1, $2, $3, $4) ON CONFLICT (account_id) DO UPDATE SET
    start_tokens=EXCLUDED.start_tokens, renewal_tokens=EXCLUDED.renewal_tokens, updated_at=EXCLUDED.updated_at`,
    [accountId, starts, renewals, new Date(now)],
  );
}

// Background maintenance, not dependent on the number of incoming requests.
// Deleting a lease never refunds its unknown balance: counters remain charged.
export async function cleanupApiRelayQuota(): Promise<{
  leases: number;
  accounts: number;
}> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('api-relay-gc')) AS acquired",
    );
    if (!lock.rows[0].acquired) {
      await client.query("COMMIT");
      return { leases: 0, accounts: 0 };
    }
    const leases = await client.query(
      `WITH expired AS (
      SELECT session_id FROM ${TABLE} WHERE delete_after <= now()
      ORDER BY delete_after LIMIT $1 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${TABLE} USING expired WHERE ${TABLE}.session_id=expired.session_id`,
      [API_RELAY_QUOTA_LIMITS.cleanupBatch],
    );
    const accounts = await client.query(
      `WITH expired AS (
      SELECT account_id FROM ${ADMISSION_TABLE} WHERE updated_at < now() - interval '1 day'
      ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${ADMISSION_TABLE} USING expired WHERE ${ADMISSION_TABLE}.account_id=expired.account_id`,
      [API_RELAY_QUOTA_LIMITS.cleanupBatch],
    );
    await client.query("COMMIT");
    return { leases: leases.rowCount ?? 0, accounts: accounts.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        opts.host_id,
        opts.project_id,
        opts.account_id,
        opts.started_at,
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
  let transaction = false;
  const commit = async () => {
    await client.query("COMMIT");
    transaction = false;
  };
  try {
    await client.query("BEGIN");
    transaction = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [opts.session_id, "api-relay-session"],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [opts.account_id, METRIC],
    );
    const { rows } = await client.query<{ state: Lease; delete_after: Date }>(
      `SELECT state, delete_after FROM ${TABLE} WHERE session_id=$1 FOR UPDATE`,
      [opts.session_id],
    );
    const old = rows[0]?.state;
    const now = Date.now();
    if (old) {
      if (rows[0].delete_after.getTime() <= now)
        throw Error("API relay lease retry period ended");
      if (
        old.host_id !== opts.host_id ||
        old.project_id !== opts.project_id ||
        old.account_id !== opts.account_id ||
        old.started_at !== opts.started_at ||
        old.category !==
          (opts.transport === "http" ? "http-proxy" : "ws-proxy") ||
        old.target !== opts.target
      ) {
        throw Error("API relay lease identity changed");
      }
      if (opts.sequence === old.sequence && old.request_hash === hash) {
        await commit();
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
    } else {
      if (
        opts.sequence !== 0 ||
        opts.sent !== 0 ||
        opts.received !== 0 ||
        opts.close
      ) {
        throw Error("API relay lease must begin with zero usage");
      }
      // Once the short retry record is collected, a delayed initial request
      // must not recreate it and reserve a second allowance for the old turn.
      if (
        opts.started_at > now + 60_000 ||
        now - opts.started_at > API_RELAY_QUOTA_LIMITS.initialRequestMaxAgeMs
      ) {
        throw Error("API relay initial request expired");
      }
    }
    if (!opts.close) {
      await admitUpdate(client, opts.account_id, !old);
      // Expired-but-unsettled sessions do not consume live slots, but every
      // retained row counts toward the hard storage bound if GC falls behind.
      const counts = await client.query<{ retained: string; active: string }>(
        `SELECT COUNT(*) AS retained,
        COUNT(*) FILTER (WHERE (state->>'closed')='false' AND expires_at > now() AND session_id <> $2) AS active
        FROM ${TABLE} WHERE account_id=$1`,
        [opts.account_id, opts.session_id],
      );
      if (
        (!old &&
          Number(counts.rows[0].retained) >=
            API_RELAY_QUOTA_LIMITS.retainedSessions) ||
        Number(counts.rows[0].active) >= API_RELAY_QUOTA_LIMITS.activeSessions
      ) {
        await commit();
        throw Object.assign(Error("account API relay session limit reached"), {
          statusCode: 429,
        });
      }
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
    let grant = 0;
    let expires_at = now;
    let window_ids: string[] = [];
    if (!opts.close) {
      const limits = getEffectiveMembershipUsageLimits(
        await resolveMembershipForAccount(opts.account_id),
      );
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
    if (!old && grant === 0) {
      await commit();
      return reply;
    }
    const state: Lease = {
      host_id: opts.host_id,
      project_id: opts.project_id,
      account_id: opts.account_id,
      started_at: opts.started_at,
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
      `INSERT INTO ${TABLE} (session_id, account_id, state, expires_at, delete_after) VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (session_id) DO UPDATE SET state=EXCLUDED.state, expires_at=EXCLUDED.expires_at, delete_after=EXCLUDED.delete_after, updated_at=now()`,
      [
        opts.session_id,
        opts.account_id,
        JSON.stringify(state),
        new Date(expires_at),
        new Date(
          opts.close
            ? now + API_RELAY_QUOTA_LIMITS.settledRetentionMs
            : expires_at + API_RELAY_QUOTA_LIMITS.settlementGraceMs,
        ),
      ],
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
    await commit();
    return reply;
  } catch (err) {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
