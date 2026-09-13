/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getLogger } from "@cocalc/backend/logger";
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { executeBillingAuthorityCommand } from "@cocalc/server/purchases/billing-authority/client";
import type { CommercialReceivablesAuthorityResult } from "./maintenance-task";

const logger = getLogger("server:commercial-orders:maintenance");
const INTERVAL_MS = 5 * 60_000;
const LEASE_MS = 10 * 60_000;
const WORKER_NAME = "commercial-receivables-maintenance-v1";
const LEASE_OWNER = `${process.pid}:${randomUUID()}`;
let timer: NodeJS.Timeout | undefined;
let running = false;

async function acquireLease(): Promise<{
  last_daily_digest_at?: Date | string | null;
} | null> {
  const { rows } = await getPool().query(
    `INSERT INTO commercial_worker_state
       (worker_name,lease_owner,lease_expires_at,last_started_at,updated_at)
     VALUES ($1,$2,$3,NOW(),NOW())
     ON CONFLICT (worker_name) DO UPDATE SET
       lease_owner=EXCLUDED.lease_owner,
       lease_expires_at=EXCLUDED.lease_expires_at,
       last_started_at=NOW(),updated_at=NOW()
     WHERE commercial_worker_state.lease_expires_at IS NULL
        OR commercial_worker_state.lease_expires_at < NOW()
        OR commercial_worker_state.lease_owner=EXCLUDED.lease_owner
     RETURNING last_daily_digest_at`,
    [WORKER_NAME, LEASE_OWNER, new Date(Date.now() + LEASE_MS)],
  );
  return rows[0] ?? null;
}

function utcDay(value?: Date | string | null): string | undefined {
  if (value == null) return;
  return new Date(value).toISOString().slice(0, 10);
}

async function finishLease({
  result,
  error,
  dailyDigest,
}: {
  result?: Record<string, unknown>;
  error?: unknown;
  dailyDigest?: boolean;
}): Promise<void> {
  await getPool().query(
    `UPDATE commercial_worker_state SET
       lease_owner=NULL,lease_expires_at=NULL,
       last_success_at=CASE WHEN $3::text IS NULL THEN NOW() ELSE last_success_at END,
       last_daily_digest_at=CASE WHEN $4 THEN NOW() ELSE last_daily_digest_at END,
       last_error=$3,last_result=$2,updated_at=NOW()
     WHERE worker_name=$1 AND lease_owner=$5`,
    [
      WORKER_NAME,
      result ?? {},
      error == null ? null : `${error}`.slice(0, 5_000),
      dailyDigest === true,
      LEASE_OWNER,
    ],
  );
}

async function run(): Promise<void> {
  if (running || getConfiguredBayId() !== getConfiguredClusterSeedBayId())
    return;
  let lease: Awaited<ReturnType<typeof acquireLease>>;
  try {
    lease = await acquireLease();
  } catch (err) {
    logger.warn("commercial receivables worker lease acquisition failed", {
      error: `${err}`,
    });
    return;
  }
  if (lease == null) return;
  running = true;
  let result: CommercialReceivablesAuthorityResult | undefined;
  let error: unknown;
  let dailyDigest = false;
  try {
    result =
      await executeBillingAuthorityCommand<CommercialReceivablesAuthorityResult>(
        {
          kind: "commercial-maintenance",
        },
      );
    await centralLog({
      event: "commercial_receivables_maintenance",
      value: result,
    });
    dailyDigest = utcDay(lease.last_daily_digest_at) !== utcDay(new Date());
    if (dailyDigest) {
      await centralLog({
        event: "commercial_receivables_daily_digest",
        value: result.diagnostics,
      });
    }
  } catch (err) {
    error = err;
    logger.warn("commercial receivables maintenance failed", {
      error: `${err}`,
    });
  } finally {
    try {
      await finishLease({ result, error, dailyDigest });
    } catch (finishError) {
      logger.warn("commercial receivables worker lease release failed", {
        error: `${finishError}`,
      });
    }
    running = false;
  }
}

export function startCommercialReceivablesMaintenance(): void {
  if (timer || getConfiguredBayId() !== getConfiguredClusterSeedBayId()) return;
  void run();
  timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref?.();
}

export function stopCommercialReceivablesMaintenanceForTests(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}

export async function runCommercialReceivablesMaintenanceOnceForTests(): Promise<void> {
  await run();
}
