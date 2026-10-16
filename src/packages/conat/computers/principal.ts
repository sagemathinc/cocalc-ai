/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A connected computer as a conat principal on its project's host
// (project-host/conat-auth.ts). Tagged by auth_actor "computer" and carrying
// none of the account, project, hub or host ids, so code that keys authority
// on those finds nothing; the host's isAllowed handles it first and allows
// only its own subjects (see ./subjects.ts).

export interface ComputerPrincipal {
  auth_actor: "computer";
  computer_id: string;
  computer_account_id: string;
  /** The one project it serves. */
  computer_project_id: string;
  /** Its host token's expiry: the socket is closed then. */
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

export function isComputerPrincipal(user: unknown): user is ComputerPrincipal {
  return (
    user != null &&
    typeof user === "object" &&
    (user as { auth_actor?: unknown }).auth_actor === "computer"
  );
}
