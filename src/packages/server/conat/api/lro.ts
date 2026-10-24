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
import {
  cancelCourseCollectChildren,
  COURSE_COLLECT_ASSIGNMENT_LRO_KIND,
} from "@cocalc/server/projects/course-collect-worker";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getHostAccessForAccount,
  hostAccessRoleCan,
} from "@cocalc/server/project-host/access";
import { cancelStaleProjectStartLros } from "@cocalc/server/projects/start-lro-cleanup";
import { assertHostOwnedHere } from "@cocalc/server/inter-bay/host-owned-here";

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
    const access = await getHostAccessForAccount({
      host_id: scope_id,
      account_id,
      admin_view: true,
    });
    const permission = mode === "read" ? "view" : "start-stop";
    if (access.exists && hostAccessRoleCan(access.role, permission)) {
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

// The scope a call names, which routed it here (see
// @cocalc/conat/hub/api/routes).
type NamedScope = { scope_type?: LroScopeType; scope_id?: string };

// Look up an operation for a call naming its scope: only an operation of
// that scope answers it.
async function getInNamedScope(
  op_id: string,
  { scope_type, scope_id }: NamedScope,
): Promise<LroSummary | undefined> {
  if (scope_type === "host" && scope_id != null) {
    // The host's bay keeps the authoritative log: never act on a stale
    // local copy.
    await assertHostOwnedHere(scope_id);
  }
  const row = await getLro(op_id);
  if (!row) return undefined;
  if (
    (scope_type != null && row.scope_type !== scope_type) ||
    // UUIDs: routing accepts any spelling, the database returns lowercase.
    (scope_id != null &&
      `${row.scope_id}`.toLowerCase() !== `${scope_id}`.toLowerCase())
  ) {
    return undefined;
  }
  return row;
}

export async function get({
  account_id,
  op_id,
  scope_type,
  scope_id,
}: {
  account_id?: string;
  op_id: string;
} & NamedScope): Promise<LroSummary | undefined> {
  const row = await getInNamedScope(op_id, { scope_type, scope_id });
  if (!row) return undefined;
  if (!account_id || account_id !== row.created_by) {
    await assertScopeAccess({
      account_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      mode: "read",
    });
  }
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
  if (scope_type === "host") {
    await assertHostOwnedHere(scope_id);
  }
  await assertScopeAccess({ account_id, scope_type, scope_id, mode: "read" });
  if (scope_type === "project") {
    await cancelStaleProjectStartLros({ project_id: scope_id });
  }
  return await listLro({ scope_type, scope_id, include_completed });
}

export async function cancel({
  account_id,
  op_id,
  scope_type,
  scope_id,
}: {
  account_id?: string;
  op_id: string;
} & NamedScope): Promise<void> {
  const row = await getInNamedScope(op_id, { scope_type, scope_id });
  if (!row) return;
  if (!account_id || account_id !== row.created_by) {
    await assertScopeAccess({
      account_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
    });
  }
  const updated = await updateLro({
    op_id,
    status: "canceled",
    error: row.error ?? "canceled",
    if_status: ["queued", "running"],
  });
  if (updated) {
    await publishLroSummary({
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
  if (row.kind === "copy-path-between-projects") {
    await cancelCopiesByOpId({ op_id, include_applying: true });
  } else if (row.kind === COURSE_COLLECT_ASSIGNMENT_LRO_KIND) {
    await cancelCourseCollectChildren({ op_id });
  }
}

export async function dismiss({
  account_id,
  op_id,
  scope_type,
  scope_id,
}: {
  account_id?: string;
  op_id: string;
} & NamedScope): Promise<void> {
  const row = await getInNamedScope(op_id, { scope_type, scope_id });
  if (!row) return;
  if (!account_id || account_id !== row.created_by) {
    await assertScopeAccess({
      account_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
    });
  }
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
