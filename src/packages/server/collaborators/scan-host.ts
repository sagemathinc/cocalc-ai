/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/** Distinguish an unavailable host observation from a database/authority error.
 * This is never proof that the host did not execute or that execution stopped.
 */
export class ScanHostUnavailable extends Error {
  constructor(cause: unknown) {
    super(`Scan host could not be reached: ${String(cause)}`);
  }
}
export async function scanHostCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new ScanHostUnavailable(error);
  }
}
