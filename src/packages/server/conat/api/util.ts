import { materializeProjectHost } from "../route-project";
import {
  assertLocalProjectCollaborator,
  PROJECT_COLLABORATOR_REQUIRED_ERROR,
} from "../project-local-access";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

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
    const ownership = await resolveProjectBay(project_id);
    if (!ownership || ownership.bay_id === getConfiguredBayId()) {
      throw err;
    }
    const remote = await getInterBayBridge()
      .projectReference(ownership.bay_id)
      .get({ account_id, project_id });
    if (!remote) {
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
