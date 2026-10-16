/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Paired computers connected to this host, each serving one project here.
// Design: src/.agents/computers-direct-host-2026-10-16.md.
//
// The host decides locally, on every check (the conat server rechecks a
// computer's socket every 15 s):
// - its token is current (the socket closes when it expires),
// - the hub hasn't dropped it (revoked: dropComputer below),
// - its project is here, not deleted, and its only collaborator is the
//   computer's owner. Adding anyone cuts the computer off at once.

import { isComputerPrincipal } from "@cocalc/conat/computers/principal";
import { COMPUTER_TOKEN_MAX_TTL_SECONDS } from "@cocalc/conat/auth/project-host-token";
import { isValidUUID } from "@cocalc/util/misc";
import { getProject } from "./sqlite/projects";

/**
 * Computers the hub dropped, until any token issued before can have expired
 * (then the hub issues none: it refuses a revoked computer).
 */
const dropped = new Map<string, number>();
const DROP_MEMORY_MS = (COMPUTER_TOKEN_MAX_TTL_SECONDS + 60) * 1000;

export function dropComputer(computer_id: string, now = Date.now()): void {
  if (!isValidUUID(computer_id)) throw new Error("invalid computer_id");
  dropped.set(computer_id, now + DROP_MEMORY_MS);
  for (const [id, until] of dropped) {
    if (until <= now) dropped.delete(id);
  }
}

export function isComputerDropped(
  computer_id: string,
  now = Date.now(),
): boolean {
  const until = dropped.get(computer_id);
  if (until == null) return false;
  if (until <= now) {
    dropped.delete(computer_id);
    return false;
  }
  return true;
}

/** Is P here, not deleted, with the account as its one collaborator (owner)? */
export function projectServesComputer(
  project_id: string,
  account_id: string,
): boolean {
  const row: any = getProject(project_id);
  if (row == null || row.deleted) return false;
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
    !isComputerDropped(user.computer_id, now) &&
    projectServesComputer(user.computer_project_id, user.computer_account_id)
  );
}

export function resetComputersForTesting(): void {
  dropped.clear();
}
