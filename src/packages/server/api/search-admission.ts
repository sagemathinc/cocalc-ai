/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/database/postgres/account-rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";

// A token bucket: 300 admissions/minute sustained, with a burst of 30.
const INTERVAL_MS = 200;
const BURST = 30;
const schemas = new WeakMap<object, Promise<void>>();

export async function ensureSearchAdmissionSchema(): Promise<void> {
  const pool = getPool();
  let pending = schemas.get(pool);
  if (!pending) {
    pending = pool
      .query(
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS api_search_next_ms BIGINT",
      )
      .then(async () => {
        await pool.query(
          "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_search_next_ms BIGINT",
        );
      })
      .catch((error) => {
        schemas.delete(pool);
        throw error;
      });
    schemas.set(pool, pending);
  }
  await pending;
}

export function nextSearchAdmission(
  previous: unknown,
  now: number,
  key = false,
): number {
  const interval = key ? 1000 : INTERVAL_MS;
  const burst = key ? 10 : BURST;
  const next = previous == null ? now : Number(previous);
  if (
    !Number.isSafeInteger(next) ||
    next < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw Error("invalid search admission clock");
  }
  const retryAfterMs = next - (burst - 1) * interval - now;
  if (retryAfterMs > 0) {
    throw Object.assign(
      new Error(
        `${key ? "key" : "account"} search rate exceeded; retry after ${Math.ceil(retryAfterMs / 1000)} seconds`,
      ),
      { code: "api_search_rate_limited", retry_after_ms: retryAfterMs },
    );
  }
  return Math.max(next, now) + interval;
}

export interface SearchAdmissionKey {
  key_id: string;
  scope_revision: number;
}

// Invoke only on the resolved account home, before the bounded summary query.
// Durable account state is copied by account rehome; process/key changes do not
// replenish the bucket. The database clock avoids independent hub clock skew.
export async function admitAccountSearch(
  account_id: string,
  key?: SearchAdmissionKey,
): Promise<void> {
  if (!isValidUUID(account_id)) throw Error("invalid account id");
  if (
    key &&
    (!/^[A-Za-z0-9_-]{8,128}$/.test(key.key_id) ||
      !Number.isSafeInteger(key.scope_revision) ||
      key.scope_revision < 1)
  ) {
    throw Error("invalid search key identity");
  }
  await ensureSearchAdmissionSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query("SET LOCAL statement_timeout = '1s'");
    await assertAccountNotRehoming({
      db: client,
      account_id,
      action: "admit API search",
    });
    await assertAccountWriteOnHomeBay({
      db: client,
      account_id,
      action: "admit API search",
    });
    const { rows } = await client.query(
      "SELECT api_search_next_ms FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE FOR UPDATE",
      [account_id],
    );
    if (!rows.length) throw Error("search account is unavailable");
    const keyRow = key
      ? (
          await client.query(
            `SELECT api_search_next_ms FROM api_keys
       WHERE account_id=$1 AND key_id=$2 AND scope_revision=$3
       AND (expire IS NULL OR expire > clock_timestamp()) FOR UPDATE`,
            [account_id, key.key_id, key.scope_revision],
          )
        ).rows[0]
      : undefined;
    if (key && !keyRow) throw Error("search key is unavailable or changed");
    const { rows: clock } = await client.query(
      "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms",
    );
    const next = nextSearchAdmission(
      rows[0].api_search_next_ms,
      Number(clock[0]?.now_ms),
    );
    const keyNext = key
      ? nextSearchAdmission(
          keyRow.api_search_next_ms,
          Number(clock[0]?.now_ms),
          true,
        )
      : undefined;
    await client.query(
      "UPDATE accounts SET api_search_next_ms=$2 WHERE account_id=$1",
      [account_id, next],
    );
    if (key)
      await client.query(
        "UPDATE api_keys SET api_search_next_ms=$3 WHERE account_id=$1 AND key_id=$2",
        [account_id, key.key_id, keyNext],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
