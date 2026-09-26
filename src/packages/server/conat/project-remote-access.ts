/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectReference } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";
import {
  getLocalProjectAccessStatus,
  getLocalProjectCollaboratorAccessStatus,
  PROJECT_COLLABORATOR_REQUIRED_ERROR,
} from "@cocalc/server/conat/project-local-access";
import {
  isProjectCollaboratorRole,
  projectAccessFromRole,
  projectAccessFromUsers,
  type ProjectAccess,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import { isValidUUID } from "@cocalc/util/misc";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import * as publicDirectoryShares from "@cocalc/server/conat/api/public-directory-shares";

const PROJECT_ACCESS_BATCH_CONCURRENCY = 20;

type LocalProjectReferenceRow = {
  project_id: string;
  title: string | null;
  host_id: string | null;
  owning_bay_id: string | null;
  usage_account_id: string | null;
  users: Record<string, any> | null;
  api_key_membership_revocation?: unknown;
  runtime_lifecycle_revision: number | null;
  allow_collaborator_destructive_storage_actions: boolean | null;
};

function projectReferenceFromLocalRow(
  row: LocalProjectReferenceRow,
): ProjectReference {
  return {
    project_id: row.project_id,
    title: row.title ?? "",
    host_id: row.host_id ?? null,
    owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
    usage_account_id: row.usage_account_id ?? null,
    users: row.users ?? {},
    api_key_membership_revocation: row.api_key_membership_revocation,
    runtime_lifecycle_revision: Number(row.runtime_lifecycle_revision ?? 0),
    allow_collaborator_destructive_storage_actions:
      row.allow_collaborator_destructive_storage_actions,
  };
}

async function loadLocalProjectReference({
  account_id,
  project_id,
  requireProjectUser = true,
}: {
  account_id: string;
  project_id: string;
  requireProjectUser?: boolean;
}): Promise<ProjectReference | null> {
  const { rows } = await getPool().query<LocalProjectReferenceRow>(
    `
      SELECT
        project_id,
        title,
        host_id,
        COALESCE(owning_bay_id, $3) AS owning_bay_id,
        usage_account_id,
        COALESCE(users, '{}'::jsonb) AS users,
        api_key_membership_revocations->$2::text AS api_key_membership_revocation,
        runtime_lifecycle_revision,
        allow_collaborator_destructive_storage_actions
      FROM projects
      WHERE project_id = $1
        AND deleted IS NOT TRUE
        ${requireProjectUser ? "AND users ? $2::text" : ""}
      LIMIT 1
    `,
    [project_id, account_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row?.project_id) {
    return null;
  }
  return projectReferenceFromLocalRow(row);
}

async function loadLocalProjectReferences(
  project_ids: string[],
): Promise<Map<string, ProjectReference>> {
  if (project_ids.length === 0) {
    return new Map();
  }
  const { rows } = await getPool().query<LocalProjectReferenceRow>(
    `
      SELECT
        project_id,
        title,
        host_id,
        COALESCE(owning_bay_id, $2) AS owning_bay_id,
        usage_account_id,
        COALESCE(users, '{}'::jsonb) AS users,
        runtime_lifecycle_revision,
        allow_collaborator_destructive_storage_actions
      FROM projects
      WHERE project_id = ANY($1::uuid[])
        AND deleted IS NOT TRUE
    `,
    [project_ids, getConfiguredBayId()],
  );
  return new Map(
    rows.map((row) => [row.project_id, projectReferenceFromLocalRow(row)]),
  );
}

export async function resolveProjectReferenceCollaboratorOrAdminAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectReference | null> {
  const collaboratorReference =
    await resolveProjectReferenceForProjectUserAllowRemote({
      account_id,
      project_id,
    });
  if (
    isProjectCollaboratorRole(collaboratorReference?.users?.[account_id]?.group)
  ) {
    return collaboratorReference;
  }
  if (!(await isAdmin(account_id))) {
    return null;
  }
  if (collaboratorReference != null) {
    return collaboratorReference;
  }

  const local = await loadLocalProjectReference({
    account_id,
    project_id,
    requireProjectUser: false,
  });
  if (local != null) {
    return local;
  }
  const ownership = await resolveProjectBay(project_id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    return null;
  }
  return await getInterBayBridge()
    .projectReference(ownership.bay_id)
    .get({ account_id, project_id });
}

async function warmProjectRoute(project_id: string): Promise<void> {
  try {
    await materializeProjectHost(project_id);
  } catch {
    // Best effort only. Remote collaborators may be routed through project-host
    // state that is not locally materialized on this bay yet.
  }
}

export async function resolveProjectReferenceAllowRemote({
  account_id,
  project_id,
  warmRoute = true,
}: {
  account_id: string;
  project_id: string;
  warmRoute?: boolean;
}): Promise<ProjectReference | null> {
  const reference = await resolveProjectReferenceForProjectUserAllowRemote({
    account_id,
    project_id,
    warmRoute,
  });
  if (!isProjectCollaboratorRole(reference?.users?.[account_id]?.group)) {
    return null;
  }
  return reference;
}

export async function resolveProjectReferenceForMemberAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectReference | null> {
  const ownership = await resolveProjectBay(project_id);
  if (!ownership?.bay_id) throw Error("project owner is unavailable");
  const reference =
    ownership.bay_id !== getConfiguredBayId()
      ? await getInterBayBridge()
          .projectReference(ownership.bay_id)
          .get({ account_id, project_id })
      : await loadLocalProjectReference({ account_id, project_id });
  if (reference && reference.owning_bay_id !== ownership.bay_id)
    throw Error("project owner changed during authorization");
  return reference;
}

async function resolveProjectReferenceForProjectUserAllowRemote({
  account_id,
  project_id,
  warmRoute = true,
}: {
  account_id: string;
  project_id: string;
  warmRoute?: boolean;
}): Promise<ProjectReference | null> {
  const access = await getLocalProjectCollaboratorAccessStatus({
    account_id,
    project_id,
  });
  if (access === "local-collaborator") {
    const local = await loadLocalProjectReference({ account_id, project_id });
    if (local != null && warmRoute) {
      await warmProjectRoute(project_id);
    }
    return local;
  }

  const ownership = await resolveProjectBay(project_id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    return null;
  }
  const remote = await getInterBayBridge()
    .projectReference(ownership.bay_id)
    .get({ account_id, project_id });
  if (
    warmRoute &&
    remote != null &&
    isProjectCollaboratorRole(remote.users?.[account_id]?.group)
  ) {
    await warmProjectRoute(project_id);
  }
  return remote;
}

export async function resolveProjectAccessAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectAccess> {
  const mergeTemporaryViewerAccess = async (
    access: ProjectAccess,
  ): Promise<ProjectAccess> => {
    if (
      access.role === "owner" ||
      access.role === "collaborator" ||
      access.role === "admin"
    ) {
      return access;
    }
    let temporaryPolicy: ProjectViewerReadPolicy | undefined;
    try {
      temporaryPolicy = (
        await publicDirectoryShares.getTemporaryViewerReadPolicy({
          account_id,
          project_id,
        })
      ).read_policy;
    } catch {
      temporaryPolicy = undefined;
    }
    if (!temporaryPolicy) {
      return access;
    }
    if (access.role === "viewer" && access.read_policy) {
      return projectAccessFromRole({
        role: "viewer",
        read_policy: {
          rules: [...access.read_policy.rules, ...temporaryPolicy.rules],
        },
      });
    }
    return projectAccessFromRole({
      role: "viewer",
      read_policy: temporaryPolicy,
    });
  };

  const localStatus = await getLocalProjectAccessStatus({
    account_id,
    project_id,
  });
  if (localStatus === "local-project-user") {
    const local = await loadLocalProjectReference({ account_id, project_id });
    return await mergeTemporaryViewerAccess(
      projectAccessFromUsers({
        account_id,
        users: local?.users,
      }),
    );
  }
  const ownership = await resolveProjectBay(project_id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    return await mergeTemporaryViewerAccess(
      projectAccessFromUsers({ account_id, users: undefined }),
    );
  }
  const remote = await getInterBayBridge()
    .projectReference(ownership.bay_id)
    .get({ account_id, project_id });
  return await mergeTemporaryViewerAccess(
    projectAccessFromUsers({
      account_id,
      users: remote?.users,
    }),
  );
}

export async function hasProjectCollaboratorAccessAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  return (
    (await resolveProjectReferenceAllowRemote({
      account_id,
      project_id,
    })) != null
  );
}

export async function assertProjectCollaboratorAccessAllowRemote({
  account_id,
  project_id,
  warmRoute = true,
}: {
  account_id?: string;
  project_id: string;
  warmRoute?: boolean;
}): Promise<ProjectReference> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const reference = await resolveProjectReferenceAllowRemote({
    account_id,
    project_id,
    warmRoute,
  });
  if (reference == null) {
    throw Error(PROJECT_COLLABORATOR_REQUIRED_ERROR);
  }
  return reference;
}

export async function assertProjectCollaboratorAccessAllowRemoteBatch({
  account_id,
  project_ids,
  warmRoute = true,
}: {
  account_id?: string;
  project_ids: string[];
  warmRoute?: boolean;
}): Promise<ProjectReference[]> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const uniqueProjectIds = Array.from(new Set(project_ids));
  if (uniqueProjectIds.some((project_id) => !isValidUUID(project_id))) {
    throw Error("invalid project_id -- all must be valid uuid's");
  }
  const local = await loadLocalProjectReferences(uniqueProjectIds);
  return await mapParallelLimit(
    uniqueProjectIds,
    async (project_id) => {
      const reference = local.get(project_id);
      if (
        reference?.owning_bay_id === getConfiguredBayId() &&
        isProjectCollaboratorRole(reference.users?.[account_id]?.group)
      ) {
        if (warmRoute) {
          await warmProjectRoute(project_id);
        }
        return reference;
      }
      return await assertProjectCollaboratorAccessAllowRemote({
        account_id,
        project_id,
        warmRoute,
      });
    },
    PROJECT_ACCESS_BATCH_CONCURRENCY,
  );
}
