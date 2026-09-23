import { validateArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { openArtifact } from "@cocalc/frontend/chat/open-artifact";
import type { AgentSearchHit } from "./search-runner";

export function sourceArtifactPublication(
  actions: ChatActions,
  result: AgentSearchHit,
) {
  if (
    actions.store?.get("project_id") !== result.agent.endpoint.project_id ||
    actions.store?.get("path") !== result.agent.path
  )
    throw Error("The artifact must open in its source conversation.");
  const records = actions.syncdb?.get({ event: "chat-artifact-publication" });
  const publication = (records?.toJS?.() ?? records ?? []).find(
    (row) =>
      row.thread_id === result.threadId &&
      row.artifact_id === result.hit.artifact_id &&
      row.operation_id === result.hit.operation_id,
  );
  if (!publication)
    throw Error("Artifact publication is unavailable. Refresh the Library.");
  return validateArtifactPublication(publication);
}

export function openSourceArtifact(
  actions: ChatActions,
  result: AgentSearchHit,
) {
  if (!actions.frameTreeActions || !actions.frameId)
    throw Error("Source workbench is still loading. Try again shortly.");
  openArtifact(actions, sourceArtifactPublication(actions, result));
}
