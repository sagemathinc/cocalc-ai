/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { requireDangerousSessionAuth } from "./dangerous-session-auth";

// Non-serializable capability used only by trusted in-process inter-bay
// handlers. Public Conat API callers cannot supply this value over JSON.
export const PROJECT_DANGEROUS_INTERNAL_AUTH = Symbol(
  "project-dangerous-internal-auth",
);

export async function requireDangerousProjectMutationAuth({
  account_id,
  session_hash,
  internalAuth,
}: {
  account_id?: string;
  session_hash?: string | null;
  internalAuth?: typeof PROJECT_DANGEROUS_INTERNAL_AUTH;
}): Promise<void> {
  if (internalAuth === PROJECT_DANGEROUS_INTERNAL_AUTH) {
    return;
  }
  await requireDangerousSessionAuth({
    account_id,
    session_hash,
    require_second_factor: true,
  });
}
