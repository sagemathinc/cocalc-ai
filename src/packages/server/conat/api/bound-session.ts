/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AuthenticatedCaller } from "@cocalc/conat/core/client";

function sessionMismatch(): Error {
  return Object.assign(
    new Error("the request names a session other than the caller's own"),
    { code: 403 },
  );
}

/**
 * The auth session of a Hub API request: the one the Conat server stamped
 * from the caller's own connection, never a value the request supplies.
 *
 * Fresh auth, impersonation and similar checks trust this value, so a
 * session of an account must not be able to borrow another session's
 * freshness by naming it. A request that names a different session is
 * refused rather than silently corrected, so a client bug shows up.
 * Callers without a stamped account session (API keys, hub services) get
 * null: they can never satisfy a fresh-auth check through the Hub API.
 */
export function boundHubApiSessionHash({
  account_id,
  caller,
  requested,
}: {
  account_id?: string;
  caller?: AuthenticatedCaller;
  requested?: unknown;
}): string | null {
  if (!account_id) {
    return null;
  }
  const bound =
    caller?.account_id === account_id &&
    typeof caller.auth_session_hash === "string" &&
    caller.auth_session_hash
      ? caller.auth_session_hash
      : null;
  if (requested != null && requested !== "" && requested !== bound) {
    throw sessionMismatch();
  }
  return bound;
}
