/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
  withAccountRehomeWriteFence,
} from "@cocalc/server/accounts/rehome-fence";
import { uuid } from "@cocalc/util/misc";
import type { MembershipClass } from "@cocalc/conat/hub/api/purchases";

export interface MembershipGrantRecord {
  id: string;
  account_id: string;
  membership_class: MembershipClass;
  source: string;
  package_id?: string | null;
  purchase_id?: number | null;
  granted_by_account_id?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  revoked_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

function getQueryClient(client?: PoolClient) {
  return client ?? getPool();
}

async function assertAccountGrantWriteAllowed({
  account_id,
  client,
}: {
  account_id: string;
  client: PoolClient;
}): Promise<void> {
  await assertAccountNotRehoming({
    db: client,
    account_id,
    action: "modify membership grants",
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id,
    action: "modify membership grants",
  });
}

export async function listActiveMembershipGrantsForAccount(
  account_id: string,
  client?: PoolClient,
): Promise<MembershipGrantRecord[]> {
  const { rows } = await getQueryClient(client).query<MembershipGrantRecord>(
    `
      SELECT
        id,
        account_id,
        membership_class,
        source,
        package_id,
        purchase_id,
        granted_by_account_id,
        starts_at,
        expires_at,
        revoked_at,
        metadata
      FROM membership_grants
      WHERE account_id = $1
        AND revoked_at IS NULL
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY starts_at DESC NULLS LAST, expires_at DESC NULLS LAST, created DESC NULLS LAST
    `,
    [account_id],
  );
  return rows;
}

export async function createMembershipGrant(
  {
    id = uuid(),
    account_id,
    membership_class,
    source,
    package_id,
    purchase_id,
    granted_by_account_id,
    starts_at,
    expires_at,
    metadata,
  }: {
    id?: string;
    account_id: string;
    membership_class: MembershipClass;
    source: string;
    package_id?: string | null;
    purchase_id?: number | null;
    granted_by_account_id?: string | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
  },
  client?: PoolClient,
): Promise<string> {
  if (client == null) {
    return await withAccountRehomeWriteFence({
      account_id,
      action: "modify membership grants",
      fn: async (db) =>
        await createMembershipGrant(
          {
            id,
            account_id,
            membership_class,
            source,
            package_id,
            purchase_id,
            granted_by_account_id,
            starts_at,
            expires_at,
            metadata,
          },
          db as PoolClient,
        ),
    });
  }
  await assertAccountGrantWriteAllowed({ account_id, client });
  await getQueryClient(client).query(
    `
      INSERT INTO membership_grants
        (id, account_id, membership_class, source, package_id, purchase_id,
         granted_by_account_id, starts_at, expires_at, metadata, created, updated)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
    `,
    [
      id,
      account_id,
      membership_class,
      source,
      package_id ?? null,
      purchase_id ?? null,
      granted_by_account_id ?? null,
      starts_at ?? null,
      expires_at ?? null,
      metadata ?? null,
    ],
  );
  return id;
}
