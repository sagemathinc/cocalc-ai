/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";

export async function assertScopeProjectsCollaborator({
  account_id,
  scope,
}: {
  account_id: string;
  scope: ApiKeyScope;
}): Promise<void> {
  for (const { project_id } of scope.projects) {
    const reference = await resolveProjectReferenceForMemberAllowRemote({
      account_id,
      project_id,
    });
    const member = reference?.users?.[account_id];
    const group = typeof member === "string" ? member : member?.group;
    if (!isProjectCollaboratorRole(group)) {
      throw new Error(
        `full collaborator access required for project ${project_id}`,
      );
    }
  }
}
