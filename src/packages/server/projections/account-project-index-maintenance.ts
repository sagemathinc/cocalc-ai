/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { drainAccountProjectIndexProjection } from "@cocalc/database/postgres/account-project-index-projector";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const logger = getLogger("server:projections:account-project-index");

const ENABLED =
  `${process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECTOR_ENABLED ?? "1"}`.trim() !==
  "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECTOR_INTERVAL_MS,
  5_000,
  500,
  10 * 60_000,
);
const BATCH_LIMIT = clampInt(
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECTOR_BATCH_LIMIT,
  100,
  1,
  10_000,
);
const MAX_BATCHES_PER_TICK = clampInt(
  process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECTOR_MAX_BATCHES_PER_TICK,
  5,
  1,
  1_000,
);

let timer: NodeJS.Timeout | undefined;
let running = false;

export interface AccountProjectIndexProjectionPassResult {
  bay_id: string;
  batches: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface RunAccountProjectIndexProjectionPassOptions {
  bay_id?: string;
  batch_limit?: number;
  max_batches_per_tick?: number;
  drain?: typeof drainAccountProjectIndexProjection;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function runAccountProjectIndexProjectionPass(
  opts?: RunAccountProjectIndexProjectionPassOptions,
): Promise<AccountProjectIndexProjectionPassResult> {
  const bay_id = `${opts?.bay_id ?? getConfiguredBayId()}`.trim() || "bay-0";
  const batch_limit = opts?.batch_limit ?? BATCH_LIMIT;
  const max_batches_per_tick =
    opts?.max_batches_per_tick ?? MAX_BATCHES_PER_TICK;
  const drain = opts?.drain ?? drainAccountProjectIndexProjection;
  const result: AccountProjectIndexProjectionPassResult = {
    bay_id,
    batches: 0,
    scanned_events: 0,
    applied_events: 0,
    inserted_rows: 0,
    deleted_rows: 0,
    event_types: {},
  };
  for (let i = 0; i < max_batches_per_tick; i += 1) {
    const batch = await drain({
      bay_id,
      limit: batch_limit,
      dry_run: false,
    });
    result.batches += 1;
    result.scanned_events += batch.scanned_events;
    result.applied_events += batch.applied_events;
    result.inserted_rows += batch.inserted_rows;
    result.deleted_rows += batch.deleted_rows;
    for (const [event_type, count] of Object.entries(batch.event_types)) {
      result.event_types[event_type] =
        (result.event_types[event_type] ?? 0) + count;
    }
    if (batch.scanned_events < batch_limit) {
      break;
    }
  }
  return result;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runAccountProjectIndexProjectionPass();
    if (result.scanned_events > 0 || result.applied_events > 0) {
      logger.info(
        "account project index projector tick applied events",
        result,
      );
    }
  } catch (err) {
    logger.error("account project index projector tick failed", err);
  } finally {
    running = false;
  }
}

export function startAccountProjectIndexProjectionMaintenance(): void {
  if (!ENABLED) {
    logger.info("account project index projector disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  timer.unref?.();
  void tick();
  logger.info("account project index projector started", {
    interval_ms: INTERVAL_MS,
    batch_limit: BATCH_LIMIT,
    max_batches_per_tick: MAX_BATCHES_PER_TICK,
  });
}

export function stopAccountProjectIndexProjectionMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
