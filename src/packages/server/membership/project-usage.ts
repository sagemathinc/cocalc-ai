/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  resolveProjectBayAcrossCluster,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";

export interface ProjectUsageRow {
  project_id: string;
  host_id?: string | null;
  provisioned?: boolean | null;
}

const PROJECT_OWNER_ACCOUNT_EXPR = "owner.account_id";

type ProjectUsageAttributionRow = ProjectUsageRow & {
  usage_account_id?: string | null;
  course?: { type?: string; account_id?: string } | null;
  owner_account_id?: string | null;
};

function getQueryClient(client?: PoolClient) {
  return client ?? getPool();
}

function resolveUsageAccountFromRow(
  row: ProjectUsageAttributionRow | undefined,
): string | undefined {
  const usageAccountId = `${row?.usage_account_id ?? ""}`.trim();
  if (usageAccountId) {
    return usageAccountId;
  }
  if (row?.course?.type === "student") {
    const courseAccountId = `${row.course.account_id ?? ""}`.trim();
    if (courseAccountId) {
      return courseAccountId;
    }
  }
  return `${row?.owner_account_id ?? ""}`.trim() || undefined;
}

export async function getProjectUsageAccountId(
  project_id: string,
  client?: PoolClient,
): Promise<string | undefined> {
  const { rows } = await getQueryClient(
    client,
  ).query<ProjectUsageAttributionRow>(
    `
      SELECT
        p.usage_account_id::text AS usage_account_id,
        p.course,
        owner.account_id AS owner_account_id
      FROM projects AS p
      LEFT JOIN LATERAL (
        SELECT u.account_id_text::text AS account_id
        FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS u(account_id_text, user_data)
        WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
        ORDER BY u.account_id_text
        LIMIT 1
      ) AS owner ON TRUE
      WHERE p.project_id = $1
        AND p.deleted IS NULL
      LIMIT 1
    `,
    [project_id],
  );
  return resolveUsageAccountFromRow(rows[0]);
}

export async function getProjectOwnerAccountId(
  project_id: string,
  client?: PoolClient,
): Promise<string | undefined> {
  const { rows } = await getQueryClient(client).query<{ account_id: string }>(
    `
      SELECT ${PROJECT_OWNER_ACCOUNT_EXPR} AS account_id
      FROM projects AS p
      LEFT JOIN LATERAL (
        SELECT u.account_id_text::text AS account_id
        FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS u(account_id_text, user_data)
        WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
        ORDER BY u.account_id_text
        LIMIT 1
      ) AS owner ON TRUE
      WHERE p.project_id = $1
        AND p.deleted IS NULL
      LIMIT 1
    `,
    [project_id],
  );
  return `${rows[0]?.account_id ?? ""}`.trim() || undefined;
}

export async function getUsageProjectCountForAccount(
  account_id: string,
  client?: PoolClient,
): Promise<number> {
  return (await listUsageProjectsForAccount(account_id, client)).length;
}

export async function listUsageProjectsForAccount(
  account_id: string,
  client?: PoolClient,
): Promise<ProjectUsageRow[]> {
  const { rows } = await getQueryClient(
    client,
  ).query<ProjectUsageAttributionRow>(
    `
      SELECT
        p.project_id,
        p.host_id,
        p.provisioned,
        p.usage_account_id::text AS usage_account_id,
        p.course,
        owner.account_id AS owner_account_id
      FROM projects AS p
      LEFT JOIN LATERAL (
        SELECT u.account_id_text::text AS account_id
        FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS u(account_id_text, user_data)
        WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
        ORDER BY u.account_id_text
        LIMIT 1
      ) AS owner ON TRUE
      WHERE p.deleted IS NULL
        AND (
          p.usage_account_id::text = $1
          OR (
            COALESCE(p.course ->> 'type', '') = 'student'
            AND COALESCE(p.course ->> 'account_id', '') = $1
          )
          OR owner.account_id = $1
        )
      ORDER BY p.project_id
    `,
    [account_id],
  );
  return rows
    .filter((row) => resolveUsageAccountFromRow(row) === account_id)
    .map(({ project_id, host_id, provisioned }) => ({
      project_id,
      host_id,
      provisioned,
    }));
}

export async function setProjectUsageAccountId(
  {
    project_id,
    account_id,
    expected_current_usage_account_id,
  }: {
    project_id: string;
    account_id?: string | null;
    expected_current_usage_account_id?: string | null;
  },
  client?: PoolClient,
): Promise<boolean> {
  if (expected_current_usage_account_id === undefined) {
    const { rows } = await getQueryClient(client).query(
      "UPDATE projects SET usage_account_id=$2 WHERE project_id=$1 RETURNING project_id",
      [project_id, account_id ?? null],
    );
    return !!rows[0];
  }
  const { rows } = await getQueryClient(client).query(
    `
      UPDATE projects
      SET usage_account_id=$2
      WHERE project_id=$1
        AND usage_account_id::text IS NOT DISTINCT FROM $3::text
      RETURNING project_id
    `,
    [project_id, account_id ?? null, expected_current_usage_account_id],
  );
  return !!rows[0];
}

export async function setProjectUsageAccountIdOnOwningBay(
  {
    project_id,
    account_id,
    expected_current_usage_account_id,
  }: {
    project_id: string;
    account_id?: string | null;
    expected_current_usage_account_id?: string | null;
  },
  client?: PoolClient,
): Promise<boolean> {
  const localOwnership = await resolveProjectBayDirect(project_id);
  const ownership =
    localOwnership ?? (await resolveProjectBayAcrossCluster(project_id));
  if (ownership == null) {
    return false;
  }
  if (ownership.bay_id === getConfiguredBayId()) {
    return await setProjectUsageAccountId(
      {
        project_id,
        account_id,
        expected_current_usage_account_id,
      },
      client,
    );
  }
  return (
    await getInterBayBridge()
      .projectControl(ownership.bay_id)
      .setUsageAccount({
        project_id,
        usage_account_id: account_id ?? null,
        expected_current_usage_account_id,
        epoch: ownership.epoch,
      })
  ).updated;
}
