/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publishAccountFeedEventBestEffort } from "@cocalc/server/account/feed";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import getLogger from "@cocalc/backend/logger";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { hardDeleteProject } from "@cocalc/server/projects/hard-delete";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:projects:ownership");

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type ProjectOwnershipRow = {
  project_id: string;
  title: string | null;
  users: any;
  last_active: Record<string, unknown> | null;
  usage_account_id: string | null;
  runtime_sponsor_account_id: string | null;
};

export type ProjectOwnershipTransferResult = {
  project_id: string;
  from_account_id: string;
  to_account_id: string;
  usage_account_id: string | null;
  runtime_sponsor_account_id: string | null;
};

export type ProjectLeaveOrDeleteResult =
  | {
      project_id: string;
      action: "removed_self";
    }
  | {
      project_id: string;
      action: "transferred";
      new_owner_account_id: string;
    }
  | {
      project_id: string;
      action: "hard_deleted" | "hard_delete_queued";
      op_id?: string;
    }
  | {
      project_id: string;
      action: "error";
      error: string;
    };

export type HardDeleteOwnedProject = (
  project_id: string,
) => Promise<{ op_id?: string } | void>;

function assertUuid(value: string, label: string): void {
  if (!isValidUUID(value)) {
    throw new Error(`${label} must be a valid uuid`);
  }
}

export function normalizeProjectUsers(usersRaw: any): Record<string, any> {
  if (!usersRaw) return {};
  if (typeof usersRaw === "object" && !Array.isArray(usersRaw)) {
    return usersRaw as Record<string, any>;
  }
  if (typeof usersRaw === "string") {
    try {
      const parsed = JSON.parse(usersRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function getProjectOwnerAccountIdFromUsers(
  usersRaw: any,
): string | undefined {
  const users = normalizeProjectUsers(usersRaw);
  return Object.entries(users)
    .filter(
      ([account_id, info]) =>
        isValidUUID(account_id) &&
        info &&
        typeof info === "object" &&
        `${info.group ?? ""}` === "owner",
    )
    .map(([account_id]) => account_id)
    .sort()[0];
}

export function getProjectCollaboratorAccountIdsFromUsers(
  usersRaw: any,
): string[] {
  const users = normalizeProjectUsers(usersRaw);
  return Object.entries(users)
    .filter(
      ([account_id, info]) =>
        isValidUUID(account_id) &&
        info &&
        typeof info === "object" &&
        `${info.group ?? ""}` === "collaborator",
    )
    .map(([account_id]) => account_id)
    .sort();
}

function lastActiveTime(
  lastActive: Record<string, unknown> | null | undefined,
  account_id: string,
): number {
  const value = lastActive?.[account_id];
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

export function chooseProjectOwnershipTransferTarget(
  usersRaw: any,
  excluding_account_id: string,
  lastActive?: Record<string, unknown> | null,
): string | undefined {
  return getProjectCollaboratorAccountIdsFromUsers(usersRaw)
    .filter((account_id) => account_id !== excluding_account_id)
    .sort((a, b) => {
      const c = lastActiveTime(lastActive, b) - lastActiveTime(lastActive, a);
      return c || a.localeCompare(b);
    })[0];
}

async function publishOldOwnerRemoval({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<void> {
  await publishAccountFeedEventBestEffort({
    account_id,
    event: {
      type: "project.remove",
      ts: Date.now(),
      account_id,
      project_id,
      reason: "membership_removed",
    },
  });
}

async function publishMembershipChanged({
  project_id,
  old_owner_account_id,
}: {
  project_id: string;
  old_owner_account_id?: string;
}): Promise<void> {
  await Promise.allSettled([
    old_owner_account_id
      ? publishOldOwnerRemoval({
          project_id,
          account_id: old_owner_account_id,
        })
      : undefined,
    publishProjectAccountFeedEventsBestEffort({
      project_id,
      default_bay_id: getConfiguredBayId(),
    }),
    syncProjectUsersOnHost({ project_id }),
  ]);
}

async function loadProjectForUpdate(
  client: Queryable,
  project_id: string,
): Promise<ProjectOwnershipRow | undefined> {
  const { rows } = await client.query<ProjectOwnershipRow>(
    `
      SELECT
        project_id,
        title,
        users,
        last_active,
        usage_account_id::text AS usage_account_id,
        runtime_sponsor_account_id::text AS runtime_sponsor_account_id
      FROM projects
      WHERE project_id=$1
        AND deleted IS NOT TRUE
      FOR UPDATE
    `,
    [project_id],
  );
  return rows[0];
}

async function removeProjectMember({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<void> {
  assertUuid(project_id, "project_id");
  assertUuid(account_id, "account_id");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "remove project collaborator",
    });
    const row = await loadProjectForUpdate(client, project_id);
    if (!row) {
      throw new Error(`project ${project_id} not found`);
    }
    const users = normalizeProjectUsers(row.users);
    const group = `${users[account_id]?.group ?? ""}`;
    if (group !== "collaborator") {
      throw new Error("account is not a removable project collaborator");
    }
    delete users[account_id];
    await client.query(
      `
        UPDATE projects
        SET users=$2::jsonb
        WHERE project_id=$1
      `,
      [project_id, JSON.stringify(users)],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishMembershipChanged({
    project_id,
    old_owner_account_id: account_id,
  });
}

export async function transferProjectOwnership({
  project_id,
  from_account_id,
  to_account_id,
}: {
  project_id: string;
  from_account_id: string;
  to_account_id: string;
}): Promise<ProjectOwnershipTransferResult> {
  assertUuid(project_id, "project_id");
  assertUuid(from_account_id, "from_account_id");
  assertUuid(to_account_id, "to_account_id");
  if (from_account_id === to_account_id) {
    throw new Error("from_account_id and to_account_id must be different");
  }

  let result: ProjectOwnershipTransferResult | undefined;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "transfer project ownership",
    });
    const row = await loadProjectForUpdate(client, project_id);
    if (!row) {
      throw new Error(`project ${project_id} not found`);
    }
    const users = normalizeProjectUsers(row.users);
    if (`${users[from_account_id]?.group ?? ""}` !== "owner") {
      throw new Error("from_account_id must be the current project owner");
    }
    if (`${users[to_account_id]?.group ?? ""}` !== "collaborator") {
      throw new Error("to_account_id must be a project collaborator");
    }

    const newOwnerInfo = {
      ...users[to_account_id],
      group: "owner",
    };
    delete users[from_account_id];
    users[to_account_id] = newOwnerInfo;

    const usageAccountId =
      row.usage_account_id == null || row.usage_account_id === from_account_id
        ? to_account_id
        : row.usage_account_id;
    const runtimeSponsorAccountId =
      row.runtime_sponsor_account_id === from_account_id
        ? to_account_id
        : row.runtime_sponsor_account_id;

    await client.query(
      `
        UPDATE projects
        SET
          users=$2::jsonb,
          usage_account_id=$3::uuid,
          runtime_sponsor_account_id=$4::uuid
        WHERE project_id=$1
      `,
      [
        project_id,
        JSON.stringify(users),
        usageAccountId,
        runtimeSponsorAccountId,
      ],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
    result = {
      project_id,
      from_account_id,
      to_account_id,
      usage_account_id: usageAccountId,
      runtime_sponsor_account_id: runtimeSponsorAccountId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await publishMembershipChanged({
    project_id,
    old_owner_account_id: from_account_id,
  });
  log.info("transferred project ownership", result);
  return result;
}

async function listOwnedProjectsForAccount(
  account_id: string,
): Promise<ProjectOwnershipRow[]> {
  const { rows } = await getPool().query<ProjectOwnershipRow>(
    `
      SELECT
        project_id,
        title,
        users,
        last_active,
        usage_account_id::text AS usage_account_id,
        runtime_sponsor_account_id::text AS runtime_sponsor_account_id
      FROM projects
      WHERE deleted IS NOT TRUE
        AND users #>> ARRAY[$1::text, 'group'] = 'owner'
      ORDER BY created, project_id
    `,
    [account_id],
  );
  return rows;
}

export async function disposeOwnedProjectsForAccountDeletion(
  account_id: string,
): Promise<ProjectLeaveOrDeleteResult[]> {
  assertUuid(account_id, "account_id");
  const rows = await listOwnedProjectsForAccount(account_id);
  const results: ProjectLeaveOrDeleteResult[] = [];
  for (const row of rows) {
    try {
      const newOwner = chooseProjectOwnershipTransferTarget(
        row.users,
        account_id,
        row.last_active,
      );
      if (newOwner) {
        await transferProjectOwnership({
          project_id: row.project_id,
          from_account_id: account_id,
          to_account_id: newOwner,
        });
        results.push({
          project_id: row.project_id,
          action: "transferred",
          new_owner_account_id: newOwner,
        });
      } else {
        await hardDeleteProject({
          project_id: row.project_id,
          account_id,
        });
        results.push({
          project_id: row.project_id,
          action: "hard_deleted",
        });
      }
    } catch (err) {
      results.push({
        project_id: row.project_id,
        action: "error",
        error: `${err}`,
      });
    }
  }
  const failed = results.filter((result) => result.action === "error");
  if (failed.length > 0) {
    throw new Error(
      `failed to dispose ${failed.length} project(s) owned by deleted account ${account_id}: ${failed
        .map((result) => `${result.project_id}: ${result.error}`)
        .join("; ")}`,
    );
  }
  return results;
}

async function loadProject(
  project_id: string,
): Promise<ProjectOwnershipRow | undefined> {
  const { rows } = await getPool().query<ProjectOwnershipRow>(
    `
      SELECT
        project_id,
        title,
        users,
        last_active,
        usage_account_id::text AS usage_account_id,
        runtime_sponsor_account_id::text AS runtime_sponsor_account_id
      FROM projects
      WHERE project_id=$1
        AND deleted IS NOT TRUE
      LIMIT 1
    `,
    [project_id],
  );
  return rows[0];
}

export async function leaveOrDeleteProjectForAccount({
  account_id,
  project_id,
  hardDeleteOwnedProject,
}: {
  account_id: string;
  project_id: string;
  hardDeleteOwnedProject?: HardDeleteOwnedProject;
}): Promise<ProjectLeaveOrDeleteResult> {
  assertUuid(account_id, "account_id");
  assertUuid(project_id, "project_id");
  try {
    const row = await loadProject(project_id);
    if (!row) {
      throw new Error(`project ${project_id} not found`);
    }
    const users = normalizeProjectUsers(row.users);
    const group = `${users[account_id]?.group ?? ""}`;
    if (group === "owner") {
      const newOwner = chooseProjectOwnershipTransferTarget(
        row.users,
        account_id,
        row.last_active,
      );
      if (newOwner) {
        await transferProjectOwnership({
          project_id,
          from_account_id: account_id,
          to_account_id: newOwner,
        });
        return {
          project_id,
          action: "transferred",
          new_owner_account_id: newOwner,
        };
      }
      const result = await (
        hardDeleteOwnedProject ??
        (async (id) => {
          await hardDeleteProject({ project_id: id, account_id });
        })
      )(project_id);
      const opId =
        result && typeof result === "object" ? result.op_id : undefined;
      return {
        project_id,
        action: opId ? "hard_delete_queued" : "hard_deleted",
        op_id: opId,
      };
    }
    if (group === "collaborator") {
      await removeProjectMember({ project_id, account_id });
      return {
        project_id,
        action: "removed_self",
      };
    }
    throw new Error("account is not a project collaborator");
  } catch (err) {
    return {
      project_id,
      action: "error",
      error: `${err}`,
    };
  }
}

export async function leaveOrDeleteProjectsForAccount({
  account_id,
  project_ids,
  hardDeleteOwnedProject,
}: {
  account_id: string;
  project_ids: string[];
  hardDeleteOwnedProject?: HardDeleteOwnedProject;
}): Promise<ProjectLeaveOrDeleteResult[]> {
  const uniqueProjectIds = [...new Set(project_ids)];
  const results: ProjectLeaveOrDeleteResult[] = [];
  for (const project_id of uniqueProjectIds) {
    results.push(
      await leaveOrDeleteProjectForAccount({
        account_id,
        project_id,
        hardDeleteOwnedProject,
      }),
    );
  }
  return results;
}
