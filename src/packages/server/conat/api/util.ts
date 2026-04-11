import { materializeProjectHost } from "../route-project";
import { assertProjectCollaboratorAccessAllowRemote } from "../project-remote-access";

export async function assertCollab({ account_id, project_id }) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
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
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
}
