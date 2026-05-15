/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import isAdmin from "@cocalc/server/accounts/is-admin";
import {
  canActorStartUsingRuntimeSponsor,
  collaboratorSponsorStartDisabledError,
  resolveRuntimeSponsorAccountId,
} from "./runtime-sponsor";

export type ProjectRuntimeSponsor = {
  sponsor_account_id: string;
  owning_bay_id: string;
  host_id?: string | null;
  users?: Record<string, { group?: string }> | null;
  allow_collaborator_starts_using_sponsor?: boolean | null;
};

export async function loadProjectRuntimeSponsor(
  project_id: string,
): Promise<ProjectRuntimeSponsor> {
  const { rows } = await getPool().query<{
    runtime_sponsor_account_id?: string | null;
    usage_account_id?: string | null;
    allow_collaborator_starts_using_sponsor?: boolean | null;
    users?: Record<string, { group?: string }> | null;
    owning_bay_id?: string | null;
    host_id?: string | null;
  }>(
    `
      SELECT runtime_sponsor_account_id, usage_account_id,
             allow_collaborator_starts_using_sponsor, users,
             owning_bay_id, host_id
        FROM projects
       WHERE project_id=$1
       LIMIT 1
    `,
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project ${project_id} not found`);
  }
  const sponsor_account_id = resolveRuntimeSponsorAccountId(row);
  if (!sponsor_account_id) {
    throw new Error(`project ${project_id} has no runtime sponsor`);
  }
  return {
    sponsor_account_id,
    owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
    host_id: row.host_id ?? null,
    users: row.users,
    allow_collaborator_starts_using_sponsor:
      row.allow_collaborator_starts_using_sponsor,
  };
}

export async function assertCanStartUsingRuntimeSponsor({
  sponsor,
  account_id,
}: {
  sponsor: ProjectRuntimeSponsor;
  account_id?: string;
}): Promise<void> {
  const is_admin = account_id ? await isAdmin(account_id) : false;
  if (
    !canActorStartUsingRuntimeSponsor({
      project: sponsor,
      sponsor_account_id: sponsor.sponsor_account_id,
      actor_account_id: account_id,
      is_admin,
    })
  ) {
    throw collaboratorSponsorStartDisabledError();
  }
}
