import { materializeProjectHost } from "../route-project";
import {
  assertLocalProjectCollaborator,
  PROJECT_COLLABORATOR_REQUIRED_ERROR,
  PROJECT_OWNED_BY_ANOTHER_BAY_ERROR,
} from "../project-local-access";
import isCollaborator from "@cocalc/server/projects/is-collaborator";

export async function assertCollab({ account_id, project_id }) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  await assertLocalProjectCollaborator({ account_id, project_id });
  // Ensure we have a cached host for downstream conat routing. Best effort:
  // failures here should not block the caller.
  try {
    await materializeProjectHost(project_id);
  } catch (_err) {
    // ignore
  }
}

export async function assertCollabAllowRemoteProjectAccess({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  try {
    await assertLocalProjectCollaborator({ account_id, project_id });
  } catch (err) {
    if (
      `${(err as Error)?.message ?? err}` !== PROJECT_OWNED_BY_ANOTHER_BAY_ERROR
    ) {
      throw err;
    }
    if (!(await isCollaborator({ account_id, project_id }))) {
      throw Error(PROJECT_COLLABORATOR_REQUIRED_ERROR);
    }
    return;
  }
  try {
    await materializeProjectHost(project_id);
  } catch (_err) {
    // ignore
  }
}
