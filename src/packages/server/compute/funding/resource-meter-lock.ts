/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { setTimeout as delay } from "node:timers/promises";

/** Acquire before financial/row locks. A busy resource retries next sweep.
 * The lock spans payer RPC so an old snapshot cannot meter beyond a cutover.
 */
export async function withFundingResourceMeterLock<T>(
  kind: "vm" | "volume",
  id: string,
  fn: () => Promise<T>,
  { retryContention = false }: { retryContention?: boolean } = {},
): Promise<T | undefined> {
  // Meter and handoff sweeps can start together on every worker tick. Retry
  // briefly before taking financial locks so a fast meter cannot starve handoff.
  const attempts = retryContention ? 5 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const acquired = await withSessionAdvisoryLock({
      lockKey: `compute-funding-meter:${kind}:${id}`,
      fn: async () => ({ result: await fn() }),
    });
    if (acquired) return acquired.result;
    if (attempt + 1 < attempts) await delay(50 * (attempt + 1));
  }
  return undefined;
}
