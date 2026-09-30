/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A conditional external credential update found a different stored payload
// than expected (compare-and-swap conflict). Callers refetch and retry.
export const EXTERNAL_CREDENTIAL_CONFLICT =
  "external credential changed concurrently";

export function isExternalCredentialConflict(err: unknown): boolean {
  return `${(err as { message?: unknown })?.message ?? err ?? ""}`.includes(
    EXTERNAL_CREDENTIAL_CONFLICT,
  );
}
