import getPool from "@cocalc/database/pool";
import type {
  LroScopeType,
  LroStatus,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";
import { assertCollabAllowRemoteProjectAccess } from "./util";
import {
  dismissLro,
  getLro,
  listLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroSummary } from "@cocalc/server/lro/stream";
import { cancelCopiesByOpId } from "@cocalc/server/projects/copy-db";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const DISMISSABLE_STATUSES: LroStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "expired",
];

async function assertScopeAccess({
  account_id,
  scope_type,
  scope_id,
  mode = "manage",
}: {
  account_id?: string;
  scope_type: LroScopeType;
  scope_id: string;
  mode?: "read" | "manage";
}) {
  if (scope_type === "project") {
    await assertCollabAllowRemoteProjectAccess({
      account_id,
      project_id: scope_id,
    });
    return;
  }
  if (!account_id) {
    throw new Error("must be signed in");
  }
  if (scope_type === "account") {
    if (account_id !== scope_id) {
      throw new Error("not authorized");
    }
    return;
  }
  if (scope_type === "host") {
    const { rows } = await getPool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [scope_id],
    );
    if (!rows[0]) {
      throw new Error("not authorized");
    }
    const metadata = rows[0].metadata ?? {};
    const isOwner = metadata.owner === account_id;
    const collabs: string[] = metadata.collaborators ?? [];
    if (isOwner || collabs.includes(account_id)) {
      return;
    }
    if (mode === "read") {
      const { rowCount } = await getPool().query(
        `
          SELECT 1
          FROM projects
          LEFT JOIN project_hosts
            ON project_hosts.id = projects.host_id
           AND project_hosts.deleted IS NULL
          WHERE projects.host_id=$1
            AND projects.deleted IS NOT true
            AND COALESCE(projects.owning_bay_id, $3) = COALESCE(project_hosts.bay_id, $3)
            AND (projects.users -> $2::text ->> 'group') IN ('owner', 'collaborator')
          LIMIT 1
        `,
        [scope_id, account_id, getConfiguredBayId()],
      );
      if (rowCount) {
        return;
      }
    }
    throw new Error("not authorized");
  }
  throw new Error("unsupported scope");
}

export async function get({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<LroSummary | undefined> {
  const row = await getLro(op_id);
  if (!row) return undefined;
  await assertScopeAccess({
    account_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    mode: "read",
  });
  return row;
}

export async function list({
  account_id,
  scope_type,
  scope_id,
  include_completed,
}: {
  account_id?: string;
  scope_type: LroScopeType;
  scope_id: string;
  include_completed?: boolean;
}): Promise<LroSummary[]> {
  await assertScopeAccess({ account_id, scope_type, scope_id, mode: "read" });
  return await listLro({ scope_type, scope_id, include_completed });
}

export async function cancel({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<void> {
  const row = await getLro(op_id);
  if (!row) return;
  await assertScopeAccess({
    account_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
  });
  const updated = await updateLro({
    op_id,
    status: "canceled",
    error: row.error ?? "canceled",
  });
  if (updated) {
    await publishLroSummary({
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
  if (row.kind === "copy-path-between-projects") {
    await cancelCopiesByOpId({ op_id });
  }
}

export async function dismiss({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<void> {
  const row = await getLro(op_id);
  if (!row) return;
  await assertScopeAccess({
    account_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
  });
  if (!DISMISSABLE_STATUSES.includes(row.status)) {
    throw new Error("can only dismiss completed operations");
  }
  const updated = await dismissLro({
    op_id,
    dismissed_by: account_id ?? null,
  });
  if (updated) {
    await publishLroSummary({
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
}
