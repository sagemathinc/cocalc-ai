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
import type { BillingAuthorityCommercialMaintenanceTask } from "@cocalc/server/purchases/billing-authority/protocol";
import type { CommercialReceivablesAuthorityResult } from "./maintenance-task";
import { updateCommercialQueueMetrics } from "./observability";
import { getCommercialOrderDiagnostics } from "./store";

const logger = getLogger("server:commercial-orders:maintenance");
const INTERVAL_MS = 10_000;
// This exceeds the authority client's ten-minute outcome wait. Renewal keeps
// normal crash recovery bounded while the initial term prevents a transient
// renewal failure from admitting an overlapping scheduler.
const LEASE_MS = 12 * 60_000;
const LEASE_RENEW_MS = 60_000;
const DIAGNOSTICS_INTERVAL_MS = 5 * 60_000;
const WORKER_NAME = "commercial-receivables-maintenance-v1";
const LEASE_OWNER = `${process.pid}:${randomUUID()}`;
const TASKS: BillingAuthorityCommercialMaintenanceTask[] = [
  "stripe-events",
  "invoices",
  "quotes",
];
let timer: NodeJS.Timeout | undefined;
let running = false;

async function acquireLease(): Promise<{
  last_daily_digest_at?: Date | string | null;
  last_result?: unknown;
} | null> {
  const { rows } = await getPool().query(
    `INSERT INTO commercial_worker_state
       (worker_name,lease_owner,lease_expires_at,last_started_at,updated_at)
     VALUES ($1,$2,clock_timestamp()+($3::TEXT||' milliseconds')::INTERVAL,
             NOW(),NOW())
     ON CONFLICT (worker_name) DO UPDATE SET
       lease_owner=EXCLUDED.lease_owner,
       lease_expires_at=EXCLUDED.lease_expires_at,
       last_started_at=NOW(),updated_at=NOW()
     WHERE commercial_worker_state.lease_expires_at IS NULL
        OR commercial_worker_state.lease_expires_at < NOW()
        OR commercial_worker_state.lease_owner=EXCLUDED.lease_owner
     RETURNING last_daily_digest_at,last_result`,
    [WORKER_NAME, LEASE_OWNER, LEASE_MS],
  );
  return rows[0] ?? null;
}

async function renewLease(): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE commercial_worker_state
        SET lease_expires_at=clock_timestamp()+
                             ($3::TEXT||' milliseconds')::INTERVAL,
            updated_at=NOW()
      WHERE worker_name=$1 AND lease_owner=$2`,
    [WORKER_NAME, LEASE_OWNER, LEASE_MS],
  );
  return rowCount === 1;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maintenanceTask(
  value: unknown,
): BillingAuthorityCommercialMaintenanceTask {
  return TASKS.includes(value as BillingAuthorityCommercialMaintenanceTask)
    ? (value as BillingAuthorityCommercialMaintenanceTask)
    : TASKS[0];
}

function nextMaintenanceTask(
  task: BillingAuthorityCommercialMaintenanceTask,
): BillingAuthorityCommercialMaintenanceTask {
  return TASKS[(TASKS.indexOf(task) + 1) % TASKS.length];
}

function diagnosticsAreDue(lastResult: Record<string, unknown>): boolean {
  const collectedAt = new Date(`${lastResult.diagnostics_collected_at ?? ""}`);
  return (
    !Number.isFinite(collectedAt.valueOf()) ||
    collectedAt.valueOf() <= Date.now() - DIAGNOSTICS_INTERVAL_MS
  );
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
  let renewing = false;
  const leaseTimer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewLease()
      .then((renewed) => {
        if (!renewed) {
          logger.error(
            "commercial receivables worker lost its scheduler lease",
          );
        }
      })
      .catch((err) =>
        logger.warn("commercial receivables worker lease renewal failed", {
          error: `${err}`,
        }),
      )
      .finally(() => {
        renewing = false;
      });
  }, LEASE_RENEW_MS);
  leaseTimer.unref?.();
  const previousResult = record(lease.last_result);
  const task = maintenanceTask(previousResult.next_task);
  const next_task = nextMaintenanceTask(task);
  const digestDue = utcDay(lease.last_daily_digest_at) !== utcDay(new Date());
  const collect_diagnostics = digestDue || diagnosticsAreDue(previousResult);
  let result: CommercialReceivablesAuthorityResult & {
    next_task: BillingAuthorityCommercialMaintenanceTask;
    diagnostics_collected_at?: string;
  } = {
    task,
    next_task,
    webhook: { processed: 0, failed: 0, disabled: true },
    reconciliation: { reconciled: 0, failed: 0, disabled: true },
    quoteReconciliation: { reconciled: 0, failed: 0, disabled: true },
    ...(typeof previousResult.diagnostics_collected_at === "string"
      ? {
          diagnostics_collected_at: previousResult.diagnostics_collected_at,
        }
      : {}),
  };
  let error: unknown;
  let dailyDigest = false;
  try {
    const authorityResult =
      await executeBillingAuthorityCommand<CommercialReceivablesAuthorityResult>(
        {
          kind: "commercial-maintenance",
          task,
        },
      );
    const diagnostics = collect_diagnostics
      ? await getCommercialOrderDiagnostics()
      : undefined;
    if (diagnostics) updateCommercialQueueMetrics(diagnostics);
    result = {
      ...authorityResult,
      next_task,
      ...(diagnostics
        ? { diagnostics_collected_at: new Date().toISOString() }
        : result.diagnostics_collected_at
          ? { diagnostics_collected_at: result.diagnostics_collected_at }
          : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
    await centralLog({
      event: "commercial_receivables_maintenance",
      value: result,
    });
    dailyDigest = digestDue && diagnostics != null;
    if (dailyDigest && diagnostics) {
      dailyDigest = false;
      await centralLog({
        event: "commercial_receivables_daily_digest",
        value: diagnostics,
      });
      dailyDigest = true;
    }
  } catch (err) {
    error = err;
    logger.warn("commercial receivables maintenance failed", {
      error: `${err}`,
    });
  } finally {
    clearInterval(leaseTimer);
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
