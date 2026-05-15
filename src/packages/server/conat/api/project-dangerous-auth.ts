/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountAuthSessionRow } from "@cocalc/server/auth/auth-sessions";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

// Non-serializable capability used only by trusted in-process inter-bay
// handlers. Public Conat API callers cannot supply this value over JSON.
export const PROJECT_DANGEROUS_INTERNAL_AUTH = Symbol(
  "project-dangerous-internal-auth",
);

export async function requireDangerousProjectMutationAuth({
  account_id,
  browser_id,
  session_hash,
  internalAuth,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  internalAuth?: typeof PROJECT_DANGEROUS_INTERNAL_AUTH;
}): Promise<AccountAuthSessionRow | undefined> {
  if (internalAuth === PROJECT_DANGEROUS_INTERNAL_AUTH) {
    return;
  }
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  const resolvedSessionHash =
    cleanedSessionHash ||
    getBrowserAuthSessionHash({
      account_id: `${account_id ?? ""}`.trim(),
      browser_id: `${browser_id ?? ""}`.trim(),
    });
  return await requireDangerousSessionAuth({
    account_id,
    session_hash: resolvedSessionHash,
    require_second_factor: true,
  });
}
