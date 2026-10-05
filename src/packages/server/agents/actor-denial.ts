/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { PROJECT_COLLABORATOR_REQUIRED_ERROR } from "@cocalc/server/conat/project-local-access";

/**
 * Whether an assertActor failure says the account may not act in the project
 * (no longer a collaborator, or disabled) rather than a transient failure.
 * Matches the message, which survives the inter-bay hop.
 */
export function isActorDenial(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err ?? ""}`;
  return (
    message.includes(PROJECT_COLLABORATOR_REQUIRED_ERROR) ||
    message.includes("account is disabled")
  );
}
