import type { ChatActions } from "../actions";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export async function hydrateConversationSearchHit(
  actions: ChatActions,
  projectId: string,
  path: string,
  threadId: string,
  hit: ChatStoreSearchHit,
  current: () => boolean,
) {
  if (hit.segment_id === "head" || !current()) return;
  const archived =
    await webapp_client.conat_client.hub.projects.chatStoreReadArchivedHit({
      project_id: projectId,
      chat_path: path,
      thread_id: threadId,
      row_id: hit.row_id,
    });
  if (!current()) return;
  if (!archived.row?.row)
    throw new Error("Archived message is no longer available");
  actions.hydrateArchivedRows([archived.row.row]);
}
