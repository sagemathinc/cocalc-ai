import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { is_valid_uuid_string as isValid } from "@cocalc/util/misc";

export const PROJECT_COLLABORATOR_REQUIRED_ERROR =
  "user must be a collaborator on project";
export const PROJECT_OWNED_BY_ANOTHER_BAY_ERROR =
  "project belongs to another bay";
export const PROJECT_NOT_FOUND_ERROR = "project not found";
export type LocalProjectCollaboratorAccessStatus =
  | "local-collaborator"
  | "wrong-bay"
  | "not-collaborator"
  | "missing-project";

function pool() {
  return getPool("long");
}

export async function assertLocalProjectOwnership({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  if (!isValid(project_id)) {
    throw Error("invalid project_id");
  }
  const { rows } = await pool().query<{ owning_bay_id: string | null }>(
    `
      SELECT COALESCE(owning_bay_id, $2) AS owning_bay_id
      FROM projects
      WHERE project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row) {
    throw Error(PROJECT_NOT_FOUND_ERROR);
  }
  if (row.owning_bay_id !== getConfiguredBayId()) {
    throw Error(PROJECT_OWNED_BY_ANOTHER_BAY_ERROR);
  }
}

async function loadProjectAccessRow({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<
  { group: string | null; owning_bay_id: string | null } | undefined
> {
  const { rows } = await pool().query<{
    group: string | null;
    owning_bay_id: string | null;
  }>(
    `
      SELECT
        users -> $2::text ->> 'group' AS "group",
        COALESCE(owning_bay_id, $3) AS owning_bay_id
      FROM projects
      WHERE project_id=$1
      LIMIT 1
    `,
    [project_id, account_id, getConfiguredBayId()],
  );
  return rows[0];
}

function assertValidIds({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!isValid(account_id) || !isValid(project_id)) {
    throw Error("invalid account_id or project_id -- all must be valid uuid's");
  }
}

export async function hasLocalProjectCollaboratorAccess({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  return (
    (await getLocalProjectCollaboratorAccessStatus({
      account_id,
      project_id,
    })) === "local-collaborator"
  );
}

export async function getLocalProjectCollaboratorAccessStatus({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<LocalProjectCollaboratorAccessStatus> {
  assertValidIds({ account_id, project_id });
  const row = await loadProjectAccessRow({ account_id, project_id });
  if (!row) {
    return "missing-project";
  }
  if (row.owning_bay_id !== getConfiguredBayId()) {
    return "wrong-bay";
  }
  return row.group === "owner" || row.group === "collaborator"
    ? "local-collaborator"
    : "not-collaborator";
}

export async function assertLocalProjectCollaborator({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  switch (
    await getLocalProjectCollaboratorAccessStatus({ account_id, project_id })
  ) {
    case "local-collaborator":
      return;
    case "wrong-bay":
      throw Error(PROJECT_OWNED_BY_ANOTHER_BAY_ERROR);
    default:
      throw Error(PROJECT_COLLABORATOR_REQUIRED_ERROR);
  }
}
