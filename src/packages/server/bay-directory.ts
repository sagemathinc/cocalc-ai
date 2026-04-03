/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import userQuery from "@cocalc/database/user-query";
import type {
  AccountBayLocation,
  BayInfo,
  HostBayLocation,
  ProjectBayLocation,
} from "@cocalc/conat/hub/api/system";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { listHosts } from "@cocalc/server/conat/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";

const DEFAULT_BAY_ID = "bay-0";

function configuredBayId(): string {
  const bayId = `${process.env.COCALC_BAY_ID ?? ""}`.trim();
  return bayId || DEFAULT_BAY_ID;
}

function configuredBayLabel(bay_id: string): string {
  const label = `${process.env.COCALC_BAY_LABEL ?? ""}`.trim();
  return label || bay_id;
}

function configuredBayRegion(): string | null {
  const region = `${process.env.COCALC_BAY_REGION ?? ""}`.trim();
  return region || null;
}

export function getSingleBayInfo(): BayInfo {
  const bay_id = configuredBayId();
  return {
    bay_id,
    label: configuredBayLabel(bay_id),
    region: configuredBayRegion(),
    deployment_mode: "single-bay",
    role: "combined",
    is_default: true,
  };
}

export async function listConfiguredBays(): Promise<BayInfo[]> {
  return [getSingleBayInfo()];
}

async function ensureAccountExists(account_id: string): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error(`invalid account id '${account_id}'`);
  }
  const { rows } = await getPool().query(
    `SELECT account_id FROM accounts
      WHERE account_id=$1
        AND (deleted IS NULL OR deleted = FALSE)
      LIMIT 1`,
    [account_id],
  );
  if (!rows[0]?.account_id) {
    throw new Error(`account '${account_id}' not found`);
  }
}

async function getVisibleProject({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<{ project_id: string; title?: string; host_id?: string | null }> {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id '${project_id}'`);
  }
  const result = (await userQuery({
    account_id,
    query: {
      projects_all: [
        {
          project_id,
          title: null,
          host_id: null,
          deleted: null,
        },
      ],
    },
    options: [{ limit: 1 }],
  })) as {
    projects_all?: Array<{
      project_id: string;
      title?: string;
      host_id?: string | null;
      deleted?: unknown;
    }>;
  };
  const row = result?.projects_all?.[0];
  if (!row || row.deleted != null) {
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
  await ensureAccountExists(target_account_id);
  return {
    account_id: target_account_id,
    home_bay_id: configuredBayId(),
    source: "single-bay-default",
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
  return {
    project_id: row.project_id,
    owning_bay_id: configuredBayId(),
    host_id: row.host_id ?? null,
    title: row.title ?? "",
    source: "single-bay-default",
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
  return {
    host_id,
    bay_id: configuredBayId(),
    name: host.name ?? "",
    source: "single-bay-default",
  };
}
