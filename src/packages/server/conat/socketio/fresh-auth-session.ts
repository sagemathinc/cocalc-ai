/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";

/**
 * The session a fresh-auth check uses: the given session, or else the one the
 * named browser signed in with. A Hub API request is bound to its caller's
 * own session and has session_hash null when the caller has none (an API
 * key); it must then not borrow a browser session by naming its browser_id.
 */
export function resolveFreshAuthSessionHash({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
}): string | undefined {
  if (session_hash === null) {
    return undefined;
  }
  const cleaned = `${session_hash ?? ""}`.trim();
  if (cleaned) {
    return cleaned;
  }
  return getBrowserAuthSessionHash({
    account_id,
    browser_id: `${browser_id ?? ""}`.trim(),
  });
}
