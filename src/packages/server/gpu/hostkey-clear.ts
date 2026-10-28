/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Clearing a pod's host-key registration (see server/gpu/hostkey.ts). Kept
apart from pods.ts and hostkey.ts, which import provider-keys.ts: removing a
key calls in here.

None of these touch `updated`: they retire a capability, not the pod's
lifecycle, which reconciliation reads from `updated`.
*/

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { HOSTKEY_IDEMPOTENCY_WINDOW_MS } from "@cocalc/server/gpu/hostkey-token";

// The token, and the host key it registered.
export const CLEARED_HOSTKEY_FIELDS = {
  hostkey_token_id: null,
  hostkey_verifier: null,
  hostkey_expires: null,
  hostkey_consumed_at: null,
  host_public_key: null,
  host_key_fingerprint: null,
} as const;

// The key that launched these pods is being removed: no token of theirs
// can register any more, and no host key of theirs is handed out. (The
// audit events keep the fingerprints.) Pass the revoking transaction's
// client, so the two commit together.
export async function clearHostkeysForCredential(
  opts: { account_id: string; credential_id: string },
  client?: PoolClient,
): Promise<number> {
  const { rowCount } = await (client ?? getPool()).query(
    `UPDATE gpu_pods
        SET hostkey_token_id = NULL, hostkey_verifier = NULL,
            hostkey_expires = NULL, hostkey_consumed_at = NULL,
            host_public_key = NULL, host_key_fingerprint = NULL
      WHERE key_owner_account_id = $1 AND credential_id = $2
        AND (hostkey_token_id IS NOT NULL OR host_public_key IS NOT NULL)`,
    [opts.account_id, opts.credential_id],
  );
  return rowCount ?? 0;
}

// Periodic cleanup (indexed on hostkey_expires and hostkey_consumed_at):
// verifiers a window past use or expiry, after which such a token is simply
// unknown. A report never runs this; it retires only its own row.
export async function clearStaleHostkeyTokens(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE gpu_pods
        SET hostkey_token_id = NULL, hostkey_verifier = NULL
      WHERE hostkey_verifier IS NOT NULL
        AND (hostkey_expires <= now() - ($1::bigint * interval '1 millisecond')
          OR hostkey_consumed_at <= now() - ($1::bigint * interval '1 millisecond'))`,
    [HOSTKEY_IDEMPOTENCY_WINDOW_MS],
  );
  return rowCount ?? 0;
}
