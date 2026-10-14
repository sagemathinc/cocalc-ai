/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A connected computer as a conat principal (server/computers/sessions.ts).
// Tagged by auth_actor "computer" and carrying none of the account, project,
// hub or host ids, so code that keys authority on those finds nothing; the
// server's isAllowed handles it first and allows only its session's exact
// subjects (see ./subjects.ts).

export interface ComputerPrincipal {
  auth_actor: "computer";
  computer_id: string;
  computer_account_id: string;
  computer_session_id: string;
  computer_generation: number;
  computer_epoch: number;
  auth_lease_exp_s: number;
  account_id?: never;
  project_id?: never;
  hub_id?: never;
  host_id?: never;
  error?: never;
  // No API-key binding and no browser session: those are person credentials.
  auth_api_key?: never;
  auth_api_key_reply_prefix?: never;
  auth_session_hash?: never;
}

export const COMPUTER_PRINCIPAL_KEYS: ReadonlySet<string> = new Set([
  "auth_actor",
  "computer_id",
  "computer_account_id",
  "computer_session_id",
  "computer_generation",
  "computer_epoch",
  "auth_lease_exp_s",
]);

export function isComputerPrincipal(user: unknown): user is ComputerPrincipal {
  return (
    user != null &&
    typeof user === "object" &&
    (user as { auth_actor?: unknown }).auth_actor === "computer"
  );
}
