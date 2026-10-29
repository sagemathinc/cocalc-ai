/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What the key lifecycle needs from the account checks (5d-2b), with no
// dependency on the rest of them.

import type { PoolClient } from "@cocalc/database/pool";

type Db = Pick<PoolClient, "query">;

// The account checks' alert kinds.
export const ACCOUNT_ALERT_KINDS = [
  "account_spend_rate",
  "account_balance_drop",
  "account_checks_disabled",
] as const;

// One provider account (identity) at a time, until the transaction ends: a
// key connected for an identity and the account checks on it serialize
// here, so the checks never act on account-wide numbers after a second key
// for the same account was stored. Both take it last, after any key fence
// row they lock, so the order is always fence rows, then this.
export async function lockProviderIdentity(
  db: Db,
  identity: { provider: string; kind: string; id: string },
): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `gpu-provider-identity:${identity.provider}:${identity.kind}:${identity.id}`,
  ]);
}

// The confirmation made with this key ends (the key was removed, replaced or
// reported compromised, or the owner withdrew it), with its samples and its
// account alerts. A new key starts unconfirmed.
export async function endAccountWatch(
  db: Db,
  credential_id: string,
  by: string,
): Promise<void> {
  await db.query(
    `UPDATE gpu_provider_account_watch
        SET confirmed_at = NULL, disabled_reason = NULL,
            rate_warning_passes = 0, rate_critical_passes = 0,
            last_asked_at = NULL, last_balance_usd = NULL, last_expected_usd = NULL,
            baseline_at = NULL, baseline_balance_usd = NULL, baseline_expected_usd = NULL,
            updated = now()
      WHERE credential_id = $1`,
    [credential_id],
  );
  await endAccountAlerts(db, credential_id, by);
}

// The key's account alerts end, for good (no later sighting reopens them).
export async function endAccountAlerts(
  db: Db,
  credential_id: string,
  by: string,
): Promise<void> {
  await db.query(
    `UPDATE gpu_alerts SET resolved_at = now(), resolved_by = $3,
            resolved_observed_at = 'infinity'
      WHERE credential_id = $1 AND kind = ANY($2::text[]) AND resolved_at IS NULL`,
    [credential_id, ACCOUNT_ALERT_KINDS, by.slice(0, 40)],
  );
}
