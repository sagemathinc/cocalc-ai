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
  RoutingContextLocation,
} from "@cocalc/conat/hub/api/system";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { ensureClusterAccountDirectorySchema } from "@cocalc/server/accounts/cluster-directory";
import {
  getConfiguredBayId,
  getConfiguredBayLabel,
  getConfiguredBayRegion,
} from "@cocalc/server/bay-config";
import { listClusterBayInfos } from "@cocalc/server/bay-registry";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  resolveHostBay as resolveHostBayAcrossCluster,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { listHosts } from "@cocalc/server/conat/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";

function resolveStoredBayId(value: unknown): string | undefined {
  const bay_id = `${value ?? ""}`.trim();
  return bay_id || undefined;
}

let clusterAccountDirectorySchemaReady: Promise<void> | undefined;

async function ensureClusterAccountDirectorySchemaOnce(): Promise<void> {
  clusterAccountDirectorySchemaReady ??= ensureClusterAccountDirectorySchema();
  await clusterAccountDirectorySchemaReady;
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
  if (isMultiBayCluster()) {
    try {
      const infos = await listClusterBayInfos();
      if (infos.length > 0) {
        return infos;
      }
    } catch {
      // Fall back to the local bay view if the seed registry is temporarily
      // unavailable; listing bays should stay best-effort.
    }
  }
  return [getSingleBayInfo()];
}

async function getAccountRow(account_id: string): Promise<{
  account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  home_bay_id?: string | null;
  source: "account-row" | "cluster-directory";
}> {
  if (!isValidUUID(account_id)) {
    throw new Error(`invalid account id '${account_id}'`);
  }
  const global = await getClusterAccountById(account_id);
  if (global?.account_id) {
    return {
      account_id: global.account_id,
      email_address: global.email_address ?? null,
      first_name: global.first_name ?? null,
      last_name: global.last_name ?? null,
      name: global.name ?? null,
      home_bay_id: global.home_bay_id ?? null,
      source: "cluster-directory",
    };
  }
  const { rows } = await getPool().query(
    `SELECT account_id, email_address, first_name, last_name, name, home_bay_id FROM accounts
      WHERE account_id=$1
        AND (deleted IS NULL OR deleted = FALSE)
      LIMIT 1`,
    [account_id],
  );
  if (!rows[0]?.account_id) {
    throw new Error(`account '${account_id}' not found`);
  }
  return {
    ...rows[0],
    source: "account-row",
  };
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

export async function resolveVisibleProjectReferenceLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectBayLocation> {
  const row = await getVisibleProject({
    account_id,
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
    email_address: row.email_address ?? undefined,
    first_name: row.first_name ?? undefined,
    last_name: row.last_name ?? undefined,
    name: row.name ?? undefined,
    home_bay_id: home_bay_id ?? getConfiguredBayId(),
    source: home_bay_id ? row.source : "single-bay-default",
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
  try {
    return await resolveVisibleProjectReferenceLocal({
      account_id: acting_account_id,
      project_id,
    });
  } catch (err) {
    const ownership = await resolveProjectBay(project_id);
    if (!ownership || ownership.bay_id === getConfiguredBayId()) {
      throw err;
    }
    const remote = await getInterBayBridge()
      .projectReference(ownership.bay_id)
      .get({
        project_id,
        account_id: acting_account_id,
      });
    if (!remote) {
      throw err;
    }
    return {
      project_id: remote.project_id,
      owning_bay_id: remote.owning_bay_id,
      host_id: remote.host_id,
      title: remote.title,
      source: "project-row",
    };
  }
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
  const localName = host?.name ?? "";
  if (!host) {
    const ownership = await resolveHostBayAcrossCluster(host_id);
    if (!ownership || ownership.bay_id === getConfiguredBayId()) {
      throw new Error(`host '${host_id}' not found`);
    }
    const remote = await getInterBayBridge()
      .hostConnection(ownership.bay_id)
      .get({
        account_id: acting_account_id,
        host_id,
      });
    return {
      host_id,
      bay_id: ownership.bay_id,
      name: remote.name ?? "",
      source: "host-row",
    };
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
    name: localName,
    source: bay_id ? "host-row" : "single-bay-default",
  };
}

async function resolveRoutingContextLocal({
  account_id,
  user_account_id,
  project_id,
  host_id,
}: {
  account_id: string;
  user_account_id: string;
  project_id: string;
  host_id?: string | null;
}): Promise<RoutingContextLocation | null> {
  await ensureClusterAccountDirectorySchemaOnce();
  const { rows } = await getPool().query<{
    account_id: string;
    account_email_address: string | null;
    account_first_name: string | null;
    account_last_name: string | null;
    account_name: string | null;
    account_home_bay_id: string | null;
    account_source: "account-row" | "cluster-directory";
    project_id: string;
    project_title: string | null;
    project_host_id: string | null;
    project_owning_bay_id: string | null;
    host_id: string | null;
    host_name: string | null;
    host_bay_id: string | null;
  }>(
    `WITH input AS (
        SELECT $1::UUID AS acting_account_id,
               $2::UUID AS target_account_id,
               $3::UUID AS project_id,
               $4::UUID AS host_id
      ),
      account_routing AS (
        SELECT COALESCE(cad.account_id, a.account_id) AS account_id,
               COALESCE(a.email_address, cad.email_address) AS email_address,
               COALESCE(cad.first_name, a.first_name) AS first_name,
               COALESCE(cad.last_name, a.last_name) AS last_name,
               COALESCE(cad.name, a.name) AS name,
               CASE
                 WHEN cad.account_id IS NOT NULL THEN cad.home_bay_id
                 ELSE a.home_bay_id
               END AS home_bay_id,
               CASE
                 WHEN cad.account_id IS NOT NULL THEN 'cluster-directory'
                 ELSE 'account-row'
               END AS source
          FROM input i
          LEFT JOIN accounts a
            ON a.account_id = i.target_account_id
           AND (a.deleted IS NULL OR a.deleted = FALSE)
          LEFT JOIN cluster_account_directory cad
            ON cad.account_id = i.target_account_id
           AND cad.provisioned = TRUE
         WHERE a.account_id IS NOT NULL OR cad.account_id IS NOT NULL
         LIMIT 1
      ),
      project_routing AS (
        SELECT p.project_id, p.title, p.host_id, p.owning_bay_id
          FROM input i
          JOIN projects p
            ON p.project_id = i.project_id
         WHERE p.deleted IS NOT TRUE
           AND p.users ? i.acting_account_id::TEXT
           AND (p.users #>> ARRAY[i.acting_account_id::TEXT, 'hide'])::BOOLEAN IS NOT TRUE
         LIMIT 1
      ),
      host_routing AS (
        SELECT ph.id AS host_id, ph.name, ph.bay_id
          FROM input i
          JOIN project_hosts ph
            ON ph.id = i.host_id
         WHERE i.host_id IS NOT NULL
           AND ph.deleted IS NULL
         LIMIT 1
      )
      SELECT ar.account_id,
             ar.email_address AS account_email_address,
             ar.first_name AS account_first_name,
             ar.last_name AS account_last_name,
             ar.name AS account_name,
             ar.home_bay_id AS account_home_bay_id,
             ar.source AS account_source,
             pr.project_id,
             pr.title AS project_title,
             pr.host_id AS project_host_id,
             pr.owning_bay_id AS project_owning_bay_id,
             hr.host_id,
             hr.name AS host_name,
             hr.bay_id AS host_bay_id
        FROM account_routing ar
        CROSS JOIN project_routing pr
        LEFT JOIN host_routing hr ON TRUE
       LIMIT 1`,
    [account_id, user_account_id, project_id, host_id ?? null],
  );
  const row = rows[0];
  if (row == null) {
    return null;
  }
  const accountHomeBayId = resolveStoredBayId(row.account_home_bay_id);
  const projectOwningBayId = resolveStoredBayId(row.project_owning_bay_id);
  const hostBayId = resolveStoredBayId(row.host_bay_id);
  return {
    account: {
      account_id: row.account_id,
      email_address: row.account_email_address ?? undefined,
      first_name: row.account_first_name ?? undefined,
      last_name: row.account_last_name ?? undefined,
      name: row.account_name ?? undefined,
      home_bay_id: accountHomeBayId ?? getConfiguredBayId(),
      source: accountHomeBayId ? row.account_source : "single-bay-default",
    },
    project: {
      project_id: row.project_id,
      owning_bay_id: projectOwningBayId ?? getConfiguredBayId(),
      host_id: row.project_host_id ?? null,
      title: row.project_title ?? "",
      source: projectOwningBayId ? "project-row" : "single-bay-default",
    },
    host:
      row.host_id == null
        ? null
        : {
            host_id: row.host_id,
            bay_id: hostBayId ?? getConfiguredBayId(),
            name: row.host_name ?? "",
            source: hostBayId ? "host-row" : "single-bay-default",
          },
  };
}

export async function resolveRoutingContext({
  account_id,
  user_account_id,
  project_id,
  host_id,
}: {
  account_id?: string;
  user_account_id?: string;
  project_id: string;
  host_id?: string | null;
}): Promise<RoutingContextLocation> {
  const acting_account_id = `${account_id ?? ""}`.trim();
  const target_account_id = `${user_account_id ?? acting_account_id}`.trim();
  if (!acting_account_id) {
    throw new Error("must be signed in");
  }
  if (!target_account_id) {
    throw new Error("account_id is required");
  }
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id '${project_id}'`);
  }
  if (host_id != null && !isValidUUID(host_id)) {
    throw new Error(`invalid host id '${host_id}'`);
  }
  if (
    target_account_id !== acting_account_id &&
    !(await isAdmin(acting_account_id))
  ) {
    throw new Error("not authorized");
  }

  const local = await resolveRoutingContextLocal({
    account_id: acting_account_id,
    user_account_id: target_account_id,
    project_id,
    host_id,
  });
  if (local != null) {
    if (host_id != null && local.host == null) {
      return {
        ...local,
        host: await resolveHostBay({ account_id: acting_account_id, host_id }),
      };
    }
    return local;
  }

  const [account, project, host] = await Promise.all([
    resolveAccountHomeBay({
      account_id: acting_account_id,
      user_account_id: target_account_id,
    }),
    resolveProjectOwningBay({ account_id: acting_account_id, project_id }),
    host_id == null
      ? Promise.resolve(null)
      : resolveHostBay({ account_id: acting_account_id, host_id }),
  ]);
  return { account, project, host };
}
