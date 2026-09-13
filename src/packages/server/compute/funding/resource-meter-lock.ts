/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { withSessionAdvisoryLock } from "@cocalc/database/pool";

/** Acquire before financial/row locks. A busy resource retries next sweep.
 * The lock spans payer RPC so an old snapshot cannot meter beyond a cutover.
 */
export function withFundingResourceMeterLock<T>(
  kind: "vm" | "volume",
  id: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return withSessionAdvisoryLock({
    lockKey: `compute-funding-meter:${kind}:${id}`,
    fn,
  });
}
