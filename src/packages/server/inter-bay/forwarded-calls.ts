/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Exactly-once execution of hub API calls forwarded to this bay.
//
// The receiving bay gives each forwarded call an id and, if it gets no
// answer, sends the call again with the same id (see edge-routing). This bay
// records each id with its outcome, so a repeated call returns the recorded
// outcome instead of running again; while the first one is still running,
// the repeat waits for it. The record is in the database because the repeat
// may reach another hub process of this bay.

import { createHash } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import { DataEncoding, decode, encode } from "@cocalc/conat/core/codec";
import getPool from "@cocalc/database/pool";

const logger = getLogger("server:inter-bay:forwarded-calls");

// A recorded outcome larger than this is not kept: a repeat then learns
// only that the call ran.
const MAX_RECORDED_BYTES = 1_000_000;
// Repeats come within seconds; keep records much longer than that.
const RETAIN_MS = 60 * 60_000;
const POLL_MS = 200;

export type ForwardedOutcome =
  | { ok: true; result: any }
  | { ok: false; error: string; attrs: Record<string, unknown> };

export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";

let ensured: Promise<void> | undefined;

export async function ensureForwardedCallSchema(): Promise<void> {
  ensured ??= (async () => {
    const client = await getPool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [
        "cocalc:hub-api-forwarded-calls-schema",
      ]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS hub_api_forwarded_calls (
          call_id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          account_id UUID,
          source_bay_id TEXT NOT NULL,
          created TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished TIMESTAMPTZ,
          outcome BYTEA,
          outcome_recorded BOOLEAN NOT NULL DEFAULT FALSE,
          call_hash TEXT
        )`);
      await client.query(`
        ALTER TABLE hub_api_forwarded_calls
          ADD COLUMN IF NOT EXISTS call_hash TEXT`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS hub_api_forwarded_calls_created_idx
          ON hub_api_forwarded_calls (created)`);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [
          "cocalc:hub-api-forwarded-calls-schema",
        ])
        .catch(() => undefined);
      client.release();
    }
  })().catch((err) => {
    ensured = undefined;
    throw err;
  });
  await ensured;
}

let lastCleanup = 0;

// Only finished calls: an unfinished record may belong to a call that is
// still running (or whose hub stalled), and deleting it would let a repeat
// run the call again. Records of calls whose hub died mid-call stay, and a
// repeat of one gets OUTCOME_UNKNOWN.
export async function deleteOldForwardedCallRecords(): Promise<void> {
  await getPool().query(
    `DELETE FROM hub_api_forwarded_calls
      WHERE finished IS NOT NULL
        AND created < now() - ($1::BIGINT * INTERVAL '1 millisecond')`,
    [RETAIN_MS],
  );
}

function cleanupOldRecords(): void {
  if (Date.now() - lastCleanup < 60_000) return;
  lastCleanup = Date.now();
  deleteOldForwardedCallRecords().catch((err) =>
    logger.warn("deleting old forwarded call records failed", {
      err: `${err}`,
    }),
  );
}

async function recordOutcome(
  call_id: string,
  outcome: ForwardedOutcome,
): Promise<void> {
  const encoded: Uint8Array = encode({
    encoding: DataEncoding.MsgPack,
    mesg: outcome,
  });
  const bytes = encoded.length > MAX_RECORDED_BYTES ? null : encoded;
  await getPool().query(
    `UPDATE hub_api_forwarded_calls
        SET finished = now(), outcome = $2, outcome_recorded = $3
      WHERE call_id = $1`,
    [call_id, bytes == null ? null : Buffer.from(bytes), bytes != null],
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => (value as any)[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`,
    )
    .join(",")}}`;
}

/**
 * A hash of everything about a forwarded call except its id: the method, its
 * arguments, the caller's authenticated context and the sending bay. A repeat
 * of the call has the same hash.
 */
export function forwardedCallHash(call: object): string {
  const { call_id: _call_id, ...rest } = call as Record<string, unknown>;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

function unknown(error: string): ForwardedOutcome {
  return { ok: false, error, attrs: { code: OUTCOME_UNKNOWN } };
}

/**
 * Run a forwarded call at most once per call_id. `run` must not throw. A
 * repeat of a call that is still running waits up to `wait_ms` for it, then
 * reports that the outcome is unknown.
 */
export async function runForwardedCallOnce({
  call_id,
  name,
  account_id,
  source_bay_id,
  call_hash,
  wait_ms,
  run,
}: {
  call_id: string;
  name: string;
  account_id?: string;
  source_bay_id: string;
  /** forwardedCallHash of the call: a repeat must be the very same call. */
  call_hash: string;
  wait_ms: number;
  run: () => Promise<ForwardedOutcome>;
}): Promise<ForwardedOutcome> {
  await ensureForwardedCallSchema();
  const { rows: claimed } = await getPool().query(
    `INSERT INTO hub_api_forwarded_calls
       (call_id, name, account_id, source_bay_id, call_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (call_id) DO NOTHING
     RETURNING call_id`,
    [call_id, name, account_id ?? null, source_bay_id, call_hash],
  );
  if (claimed.length > 0) {
    cleanupOldRecords();
    const outcome = await run();
    try {
      await recordOutcome(call_id, outcome);
    } catch (err) {
      // The call ran; a repeat will report its outcome as unknown.
      logger.warn("recording a forwarded call's outcome failed", {
        call_id,
        name,
        err: `${err}`,
      });
    }
    return outcome;
  }

  // A repeat of a call this bay has seen.
  const deadline = Date.now() + wait_ms;
  for (;;) {
    const { rows } = await getPool().query<{
      call_hash: string | null;
      finished: Date | null;
      outcome: Buffer | null;
      outcome_recorded: boolean;
    }>(
      `SELECT call_hash, finished, outcome, outcome_recorded
         FROM hub_api_forwarded_calls
        WHERE call_id = $1`,
      [call_id],
    );
    const row = rows[0];
    if (row == null) {
      return unknown(`outcome unknown: no record of call ${call_id}`);
    }
    if (row.call_hash !== call_hash) {
      return {
        ok: false,
        error: `call ${call_id} was already used for a different call`,
        attrs: { code: 400 },
      };
    }
    if (row.finished != null) {
      if (row.outcome_recorded && row.outcome != null) {
        return decode({ encoding: DataEncoding.MsgPack, data: row.outcome });
      }
      return unknown(
        `outcome unknown: '${name}' ran, but its outcome was not recorded`,
      );
    }
    if (Date.now() >= deadline) {
      return unknown(`outcome unknown: '${name}' is still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
