import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";

/** New course associations and expanded commitments require current project access.
 * Payer-owned financial history and cleanup do not confer project access.
 */
export async function assertCourseAccess(
  account_id: string,
  project_id: string,
) {
  const ownership = await resolveProjectBay(project_id);
  if (!ownership) throw Error("course project not found");
  if (ownership.bay_id === getConfiguredBayId()) {
    await assertLocalProjectCollaborator({ account_id, project_id });
    return;
  }
  const reference = await getInterBayBridge()
    .projectReference(ownership.bay_id)
    .get({ account_id, project_id });
  if (
    reference?.project_id !== project_id ||
    reference.owning_bay_id !== ownership.bay_id ||
    !isProjectCollaboratorRole(reference.users?.[account_id]?.group)
  )
    throw Error("course project collaborator access required");
}
