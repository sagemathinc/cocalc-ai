import { readArtifact, validateArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { openArtifact } from "@cocalc/frontend/chat/open-artifact";
import type { AgentSearchHit } from "./search-runner";

/** Resolve through the source runtime; only the destination owns the new tab. */
export async function openCatalogArtifact({
  result,
  destination,
  getIdentity,
  openSource,
  canceled,
  sourceIsDestination = false,
}: {
  result: AgentSearchHit;
  destination: ChatActions;
  getIdentity: () => Promise<{ thread_id: string }>;
  openSource: () => Promise<{ getArtifactSyncdb: () => any }>;
  canceled: () => boolean;
  sourceIsDestination?: boolean;
}) {
  if (!destination.frameTreeActions || !destination.frameId)
    throw Error("Open an agent workbench before opening an artifact.");
  const { agent, threadId, hit, historical } = result;
  const identity = await getIdentity();
  if (canceled()) return;
  if (!historical && identity.thread_id !== threadId)
    throw Error(
      "This agent started a fresh conversation. Refresh the artifacts.",
    );
  const source = await openSource();
  if (canceled()) return;
  const syncdb = source.getArtifactSyncdb();
  readArtifact(syncdb, { thread_id: threadId, artifact_id: hit.artifact_id! });
  const records = syncdb.get({ event: "chat-artifact-publication" });
  const publication = (records?.toJS?.() ?? records ?? []).find(
    (row) =>
      row.thread_id === threadId &&
      row.artifact_id === hit.artifact_id &&
      row.operation_id === hit.operation_id,
  );
  if (!publication)
    throw Error("Artifact publication is unavailable. Refresh the artifacts.");
  openArtifact(
    destination,
    validateArtifactPublication(publication),
    undefined,
    sourceIsDestination
      ? undefined
      : {
          project_id: agent.endpoint.project_id,
          path: agent.path,
          agent_id: agent.endpoint.agent_id,
        },
  );
}
