/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

export type AdminAssignedMembershipRow = {
  account_id: string;
  membership_class: string;
  assigned_by: string;
  assigned_at: Date;
  expires_at?: Date | null;
  notes?: string | null;
};

type DateLike = Date | string | number | null | undefined;

function normalizeDateLike(value: DateLike): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function getAdminAssignedMembershipLocal(
  account_id: string,
): Promise<AdminAssignedMembershipRow | undefined> {
  const { rows } = await getPool("medium").query<AdminAssignedMembershipRow>(
    `SELECT account_id, membership_class, assigned_by, assigned_at, expires_at, notes
       FROM admin_assigned_memberships
      WHERE account_id=$1`,
    [account_id],
  );
  return rows[0];
}

export async function setAdminAssignedMembershipLocal({
  account_id,
  actor_account_id,
  membership_class,
  assigned_at = new Date(),
  expires_at,
  notes,
}: {
  account_id: string;
  actor_account_id: string;
  membership_class: string;
  assigned_at?: DateLike;
  expires_at?: DateLike;
  notes?: string | null;
}): Promise<void> {
  await getPool("medium").query(
    `INSERT INTO admin_assigned_memberships
       (account_id, membership_class, assigned_by, assigned_at, expires_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id)
     DO UPDATE SET
       membership_class=EXCLUDED.membership_class,
       assigned_by=EXCLUDED.assigned_by,
       assigned_at=EXCLUDED.assigned_at,
       expires_at=EXCLUDED.expires_at,
       notes=EXCLUDED.notes`,
    [
      account_id,
      membership_class,
      actor_account_id,
      normalizeDateLike(assigned_at),
      normalizeDateLike(expires_at),
      notes ?? null,
    ],
  );
}

export async function clearAdminAssignedMembershipLocal({
  account_id,
}: {
  account_id: string;
}): Promise<void> {
  await getPool("medium").query(
    "DELETE FROM admin_assigned_memberships WHERE account_id=$1",
    [account_id],
  );
}
