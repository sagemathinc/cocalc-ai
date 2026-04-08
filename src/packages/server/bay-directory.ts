/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  AccountBayLocation,
  BayInfo,
  HostBayLocation,
  ProjectBayLocation,
} from "@cocalc/conat/hub/api/system";
import isAdmin from "@cocalc/server/accounts/is-admin";
import {
  getConfiguredBayId,
  getConfiguredBayLabel,
  getConfiguredBayRegion,
} from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { listHosts } from "@cocalc/server/conat/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";

function resolveStoredBayId(value: unknown): string | undefined {
  const bay_id = `${value ?? ""}`.trim();
  return bay_id || undefined;
}

export function getSingleBayInfo(): BayInfo {
  const bay_id = getConfiguredBayId();
  const clusterRole = getConfiguredClusterRole();
  return {
    bay_id,
    label: getConfiguredBayLabel(bay_id),
    region: getConfiguredBayRegion(),
    deployment_mode: isMultiBayCluster() ? "multi-bay" : "single-bay",
    role: clusterRole === "standalone" ? "combined" : clusterRole,
    is_default: true,
  };
}

export async function listConfiguredBays(): Promise<BayInfo[]> {
  return [getSingleBayInfo()];
}

async function getAccountRow(account_id: string): Promise<{
  account_id: string;
  home_bay_id?: string | null;
}> {
  if (!isValidUUID(account_id)) {
    throw new Error(`invalid account id '${account_id}'`);
  }
  const { rows } = await getPool().query(
    `SELECT account_id, home_bay_id FROM accounts
      WHERE account_id=$1
        AND (deleted IS NULL OR deleted = FALSE)
      LIMIT 1`,
    [account_id],
  );
  if (!rows[0]?.account_id) {
    throw new Error(`account '${account_id}' not found`);
  }
  return rows[0];
}

async function getVisibleProject({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<{
  project_id: string;
  title?: string;
  host_id?: string | null;
  owning_bay_id?: string | null;
}> {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id '${project_id}'`);
  }
  // Use direct SQL for backend placement lookups. `userQuery` is designed for
  // handling user-driven queries and carries extra security/policy machinery
  // that backend code should generally avoid unless it is intentionally
  // implementing that user-query surface.
  const { rows } = await getPool().query(
    `SELECT project_id, title, host_id, owning_bay_id
      FROM projects
      WHERE project_id=$1
        AND deleted IS NOT true
        AND users ? $2
        AND (users#>>'{${account_id},hide}')::BOOLEAN IS NOT TRUE
      LIMIT 1`,
    [project_id, account_id],
  );
  const row = rows[0];
  if (!row?.project_id) {
    throw new Error(`project '${project_id}' not found`);
  }
  return row;
}

export async function resolveAccountHomeBay({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id?: string;
}): Promise<AccountBayLocation> {
  const acting_account_id = `${account_id ?? ""}`.trim();
  const target_account_id = `${user_account_id ?? acting_account_id}`.trim();
  if (!acting_account_id) {
    throw new Error("must be signed in");
  }
  if (!target_account_id) {
    throw new Error("account_id is required");
  }
  if (
    target_account_id !== acting_account_id &&
    !(await isAdmin(acting_account_id))
  ) {
    throw new Error("not authorized");
  }
  const row = await getAccountRow(target_account_id);
  const home_bay_id = resolveStoredBayId(row.home_bay_id);
  return {
    account_id: target_account_id,
    home_bay_id: home_bay_id ?? getConfiguredBayId(),
    source: home_bay_id ? "account-row" : "single-bay-default",
  };
}

export async function resolveProjectOwningBay({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectBayLocation> {
  const acting_account_id = `${account_id ?? ""}`.trim();
  if (!acting_account_id) {
    throw new Error("must be signed in");
  }
  const row = await getVisibleProject({
    account_id: acting_account_id,
    project_id,
  });
  const owning_bay_id = resolveStoredBayId(row.owning_bay_id);
  return {
    project_id: row.project_id,
    owning_bay_id: owning_bay_id ?? getConfiguredBayId(),
    host_id: row.host_id ?? null,
    title: row.title ?? "",
    source: owning_bay_id ? "project-row" : "single-bay-default",
  };
}

export async function resolveHostBay({
  account_id,
  host_id,
}: {
  account_id?: string;
  host_id: string;
}): Promise<HostBayLocation> {
  const acting_account_id = `${account_id ?? ""}`.trim();
  if (!acting_account_id) {
    throw new Error("must be signed in");
  }
  if (!isValidUUID(host_id)) {
    throw new Error(`invalid host id '${host_id}'`);
  }
  const hosts = await listHosts({
    account_id: acting_account_id,
    include_deleted: false,
    catalog: true,
    show_all: true,
  });
  const host = hosts.find((x) => x.id === host_id);
  if (!host) {
    throw new Error(`host '${host_id}' not found`);
  }
  const { rows } = await getPool().query(
    `SELECT bay_id FROM project_hosts
      WHERE id=$1
        AND deleted IS NULL
      LIMIT 1`,
    [host_id],
  );
  const bay_id = resolveStoredBayId(rows[0]?.bay_id);
  return {
    host_id,
    bay_id: bay_id ?? getConfiguredBayId(),
    name: host.name ?? "",
    source: bay_id ? "host-row" : "single-bay-default",
  };
}
