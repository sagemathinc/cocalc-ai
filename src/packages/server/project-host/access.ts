/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import type {
  HostAccessEntry,
  HostAccessRole,
  HostEffectiveAccessRole,
} from "@cocalc/conat/hub/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";

export type HostPermission =
  | "view"
  | "place"
  | "start-stop"
  | "manage-access"
  | "view-projects"
  | "configure-project-ram"
  | "configure-spend-caps"
  | "destructive";

export interface HostAccessRecord extends HostAccessEntry {
  created_at: Date | null;
  updated_at: Date | null;
  revoked_at?: Date | null;
}

export interface HostAccessResolution {
  host_id: string;
  account_id: string;
  owner_account_id?: string;
  role?: HostEffectiveAccessRole;
  delegated_role?: HostAccessRole;
  is_admin: boolean;
  exists: boolean;
}

type HostOwnerRow = {
  id: string;
  metadata: any;
};

function queryClient(client?: PoolClient) {
  return client ?? getPool();
}

function normalizeAccountId(value?: string | null): string {
  return `${value ?? ""}`.trim();
}

function normalizeRole(value?: string | null): HostAccessRole {
  const role = `${value ?? ""}`.trim().toLowerCase();
  if (role !== "user" && role !== "manager") {
    throw Error("role must be 'user' or 'manager'");
  }
  return role;
}

function getOwnerFromMetadata(metadata: any): string {
  return normalizeAccountId(metadata?.owner ?? metadata?.owner_account_id);
}

function serializeAccessRow(row: any): HostAccessRecord {
  return {
    host_id: row.host_id,
    account_id: row.account_id,
    role: normalizeRole(row.role),
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
    revoked_at: row.revoked_at ?? null,
    revoked_by: row.revoked_by ?? null,
  };
}

async function loadHostOwnerRow({
  host_id,
  client,
}: {
  host_id: string;
  client?: PoolClient;
}): Promise<HostOwnerRow | undefined> {
  const { rows } = await queryClient(client).query<HostOwnerRow>(
    `SELECT id, metadata
     FROM project_hosts
     WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  return rows[0];
}

async function getDelegatedRole({
  host_id,
  account_id,
  client,
}: {
  host_id: string;
  account_id: string;
  client?: PoolClient;
}): Promise<HostAccessRole | undefined> {
  const { rows } = await queryClient(client).query<{ role: string }>(
    `SELECT role
     FROM project_host_access
     WHERE host_id=$1
       AND account_id=$2
       AND revoked_at IS NULL`,
    [host_id, account_id],
  );
  return rows[0]?.role ? normalizeRole(rows[0].role) : undefined;
}

export function hostAccessRoleCan(
  role: HostEffectiveAccessRole | undefined,
  permission: HostPermission,
): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  switch (permission) {
    case "view":
      return role === "owner" || role === "manager" || role === "user";
    case "place":
      return role === "owner" || role === "manager" || role === "user";
    case "start-stop":
      return role === "owner" || role === "manager";
    case "manage-access":
      return role === "owner" || role === "manager";
    case "view-projects":
      return role === "owner" || role === "manager";
    case "configure-project-ram":
      return role === "owner" || role === "manager";
    case "configure-spend-caps":
      return role === "owner";
    case "destructive":
      return role === "owner";
  }
}

export async function getHostAccessForAccount({
  host_id,
  account_id,
  admin_view = false,
  client,
}: {
  host_id: string;
  account_id?: string | null;
  admin_view?: boolean;
  client?: PoolClient;
}): Promise<HostAccessResolution> {
  const normalizedHostId = normalizeAccountId(host_id);
  const normalizedAccountId = normalizeAccountId(account_id);
  if (!isValidUUID(normalizedHostId)) {
    throw Error("host_id must be a valid uuid");
  }
  const row = await loadHostOwnerRow({ host_id: normalizedHostId, client });
  const owner = getOwnerFromMetadata(row?.metadata);
  const admin =
    !!normalizedAccountId &&
    (admin_view ? await isAdmin(normalizedAccountId) : false);

  let delegatedRole: HostAccessRole | undefined;
  let role: HostEffectiveAccessRole | undefined;
  if (normalizedAccountId && owner === normalizedAccountId) {
    role = "owner";
  } else if (normalizedAccountId) {
    delegatedRole = await getDelegatedRole({
      host_id: normalizedHostId,
      account_id: normalizedAccountId,
      client,
    });
    role = delegatedRole;
  }
  if (!role && admin) {
    role = "admin";
  }

  return {
    host_id: normalizedHostId,
    account_id: normalizedAccountId,
    owner_account_id: owner || undefined,
    role,
    delegated_role: delegatedRole,
    is_admin: admin,
    exists: row != null,
  };
}

export async function requireHostPermission({
  host_id,
  account_id,
  permission,
  admin_view = false,
  client,
}: {
  host_id: string;
  account_id?: string | null;
  permission: HostPermission;
  admin_view?: boolean;
  client?: PoolClient;
}): Promise<HostAccessResolution> {
  const access = await getHostAccessForAccount({
    host_id,
    account_id,
    admin_view,
    client,
  });
  if (!access.exists) {
    throw Error("host not found");
  }
  if (!hostAccessRoleCan(access.role, permission)) {
    throw Error("not allowed to access this host");
  }
  return access;
}

export async function listHostAccessEntries({
  host_id,
  include_revoked = false,
  client,
}: {
  host_id: string;
  include_revoked?: boolean;
  client?: PoolClient;
}): Promise<HostAccessRecord[]> {
  const { rows } = await queryClient(client).query(
    `
      SELECT host_id, account_id, role, created_by, created_at, updated_by,
             updated_at, revoked_at, revoked_by
      FROM project_host_access
      WHERE host_id=$1
        AND ($2::boolean OR revoked_at IS NULL)
      ORDER BY role, updated_at DESC, account_id
    `,
    [host_id, include_revoked],
  );
  return rows.map(serializeAccessRow);
}

export async function setHostAccessEntry({
  host_id,
  actor_account_id,
  target_account_id,
  role,
  client,
}: {
  host_id: string;
  actor_account_id: string;
  target_account_id: string;
  role: HostAccessRole;
  client?: PoolClient;
}): Promise<HostAccessRecord> {
  const normalizedRole = normalizeRole(role);
  const actor = normalizeAccountId(actor_account_id);
  const target = normalizeAccountId(target_account_id);
  await requireHostPermission({
    host_id,
    account_id: actor,
    permission: "manage-access",
    admin_view: true,
    client,
  });
  const row = await loadHostOwnerRow({ host_id, client });
  const owner = getOwnerFromMetadata(row?.metadata);
  if (target === owner) {
    throw Error("owner access is implicit and cannot be changed");
  }
  if (!(await isValidAccount(target))) {
    throw Error("target account is not valid");
  }

  const { rows } = await queryClient(client).query(
    `
      INSERT INTO project_host_access
        (host_id, account_id, role, created_by, created_at, updated_by,
         updated_at, revoked_at, revoked_by)
      VALUES
        ($1, $2, $3, $4, NOW(), $4, NOW(), NULL, NULL)
      ON CONFLICT (host_id, account_id) DO UPDATE SET
        role=EXCLUDED.role,
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW(),
        revoked_at=NULL,
        revoked_by=NULL
      RETURNING host_id, account_id, role, created_by, created_at, updated_by,
                updated_at, revoked_at, revoked_by
    `,
    [host_id, target, normalizedRole, actor],
  );
  return serializeAccessRow(rows[0]);
}

export async function removeHostAccessEntry({
  host_id,
  actor_account_id,
  target_account_id,
  client,
}: {
  host_id: string;
  actor_account_id: string;
  target_account_id: string;
  client?: PoolClient;
}): Promise<HostAccessRecord | undefined> {
  const actor = normalizeAccountId(actor_account_id);
  const target = normalizeAccountId(target_account_id);
  await requireHostPermission({
    host_id,
    account_id: actor,
    permission: "manage-access",
    admin_view: true,
    client,
  });
  const row = await loadHostOwnerRow({ host_id, client });
  const owner = getOwnerFromMetadata(row?.metadata);
  if (target === owner) {
    throw Error("owner access is implicit and cannot be revoked");
  }

  const { rows } = await queryClient(client).query(
    `
      UPDATE project_host_access
      SET revoked_at=NOW(), revoked_by=$3, updated_by=$3, updated_at=NOW()
      WHERE host_id=$1
        AND account_id=$2
        AND revoked_at IS NULL
      RETURNING host_id, account_id, role, created_by, created_at, updated_by,
                updated_at, revoked_at, revoked_by
    `,
    [host_id, target, actor],
  );
  return rows[0] ? serializeAccessRow(rows[0]) : undefined;
}
