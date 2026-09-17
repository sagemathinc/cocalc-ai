/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";

function assertSeedBay(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("membership recipient deletion state is seed-authoritative");
  }
}

export async function beginMembershipRecipientDeletion(
  account_id: string,
): Promise<void> {
  assertSeedBay();
  // Commit this marker independently before taking package/assignment locks.
  // Existing producers hold the same row lock until their transaction commits.
  await getPool().query(
    `INSERT INTO membership_recipient_deletions (account_id, deleting_at)
     VALUES ($1, NOW()) ON CONFLICT (account_id) DO UPDATE
     SET deleting_at=COALESCE(membership_recipient_deletions.deleting_at, NOW())`,
    [account_id],
  );
}

export async function assertMembershipRecipientNotDeleting(
  account_id: string,
  client: PoolClient,
): Promise<void> {
  // Producers must acquire this lock before request, package, or schema locks
  // and retain it until commit, so replacement and approval serialize safely.
  assertSeedBay();
  await client.query(
    `INSERT INTO membership_recipient_deletions (account_id) VALUES ($1)
     ON CONFLICT (account_id) DO NOTHING`,
    [account_id],
  );
  const { rows } = await client.query(
    `SELECT deleting_at FROM membership_recipient_deletions
     WHERE account_id=$1 FOR UPDATE`,
    [account_id],
  );
  if (rows[0]?.deleting_at != null) {
    throw Error("account deletion has started; membership changes are blocked");
  }
}
