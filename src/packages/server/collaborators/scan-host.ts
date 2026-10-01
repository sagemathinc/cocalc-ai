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
/** The host answered, but its owner temporarily rejected an ingestion slot.
 * Preserve this execution for the normal bounded worker retry cadence.
 */
export class ScanHostBusy extends Error {}
export async function scanHostCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // Existing owner/host RPCs decorate this message without retaining a typed
    // overload result. Match only their specific admission-pressure response;
    // generic timeouts and unknown failures must still retain stop recovery.
    if (
      /\bcollaboration ingestion busy; retry later(?:$| - callHub:)/.test(
        String(error),
      )
    )
      throw new ScanHostBusy(String(error));
    throw new ScanHostUnavailable(error);
  }
}
