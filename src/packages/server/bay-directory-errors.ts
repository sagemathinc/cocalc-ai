/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Errors thrown by bay-directory, in a module with no imports, so a caller
// that only needs to recognize them does not load the whole directory (the
// inter-bay bridge, host APIs, ...).

// No live account row exists for this id: it was deleted, or never existed.
export class AccountNotFoundError extends Error {
  constructor(readonly account_id: string) {
    super(`account '${account_id}' not found`);
    this.name = "AccountNotFoundError";
  }
}

// By name, so it also matches an instance from another copy of this module.
export function isAccountNotFoundError(err: unknown): boolean {
  return (err as Error | undefined)?.name === "AccountNotFoundError";
}
