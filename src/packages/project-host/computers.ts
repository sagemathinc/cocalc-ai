/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Paired computers connected to this host, each serving one project here.
// Design: src/.agents/computers-direct-host-2026-10-16.md.
//
// The host decides locally, on every check (the conat server rechecks a
// computer's socket every 15 s), in whichever router process holds it:
// - its token is current (the socket is closed when it expires),
// - the site's computers switch is on and the hub hasn't dropped it
//   (revoked): both are in the host's database (sqlite/computer-access.ts),
//   written by the master from the hub's dropComputer call and from the
//   15 s status sync, so every process sees them,
// - its project is here, not deleted, and its only collaborator is the
//   computer's owner. Adding anyone cuts the computer off at once.

import { isComputerPrincipal } from "@cocalc/conat/computers/principal";
import { COMPUTER_TOKEN_MAX_TTL_SECONDS } from "@cocalc/conat/auth/project-host-token";
import { getProject } from "./sqlite/projects";
import {
  computersEnabledOnHost,
  isComputerDroppedInDb,
  recordComputerDrop,
  setComputersEnabledOnHost,
} from "./sqlite/computer-access";

/** A drop lasts until any token issued before it can have expired. */
export const DROP_MEMORY_MS = (COMPUTER_TOKEN_MAX_TTL_SECONDS + 60) * 1000;

export function dropComputer(computer_id: string, now = Date.now()): void {
  recordComputerDrop(computer_id, now + DROP_MEMORY_MS, now);
}

export function isComputerDropped(
  computer_id: string,
  now = Date.now(),
): boolean {
  return isComputerDroppedInDb(computer_id, now);
}

/** What the hub says now (the 15 s status sync): the switch, and revocations. */
export function applyComputerAccess(
  { enabled, revoked }: { enabled: boolean; revoked: string[] },
  now = Date.now(),
): void {
  setComputersEnabledOnHost(enabled === true);
  for (const computer_id of revoked ?? []) {
    try {
      dropComputer(computer_id, now);
    } catch {
      // not a computer id: ignore
    }
  }
}

/**
 * Is P here, not deleted, with the account as its one collaborator (owner)?
 * Only a versioned copy from the owning bay counts: an unversioned one could
 * be older than a collaborator change (sqlite/projects.ts).
 */
export function projectServesComputer(
  project_id: string,
  account_id: string,
): boolean {
  const row: any = getProject(project_id);
  if (row == null || row.deleted || row.users_revision == null) return false;
  const users = row.users;
  if (users == null || typeof users !== "object") return false;
  const entries = Object.entries(users);
  if (entries.length !== 1) return false;
  const [id, entry] = entries[0] as [string, any];
  const group = typeof entry === "string" ? entry : entry?.group;
  return id === account_id && group === "owner";
}

/** Everything that must hold for a computer principal to keep any access. */
export function computerStillAllowed(user: unknown, now = Date.now()): boolean {
  if (!isComputerPrincipal(user)) return false;
  return (
    now < Number(user.auth_lease_exp_s) * 1000 &&
    computersEnabledOnHost() &&
    !isComputerDropped(user.computer_id, now) &&
    projectServesComputer(user.computer_project_id, user.computer_account_id)
  );
}
