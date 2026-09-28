import { redux } from "@cocalc/frontend/app-framework";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type { AgentSearchHit } from "./search-runner";
import { closedCollaboratorsState } from "@cocalc/frontend/collaborators/navigation";
import { cancelPersonalUrlNavigation } from "@cocalc/frontend/personal-url-state";
import { resolvePersonalUrl } from "@cocalc/frontend/personal-url-navigation";
import { personalUrlPath } from "@cocalc/util/personal-urls";

/** Library navigation never selects or starts an agent. */
export function openLibrary(projectId?: string, entryId?: string) {
  cancelPersonalUrlNavigation();
  const page = redux.getActions("page");
  if (projectId && !entryId) {
    const owner = redux.getStore("account")?.get("account_id");
    if (!owner) return;
    void resolvePersonalUrl(personalUrlPath(owner, "artifacts", projectId));
    return page.set_active_tab("agents");
  }
  page.setState({
    ...closedCollaboratorsState,
    library_open: true,
    library_project_id: projectId,
    library_entry_id: entryId,
  });
  return page.set_active_tab("agents");
}

export function libraryConversationHit(
  agent: NamedAgent,
  target: ForeignArtifactTarget,
): AgentSearchHit {
  return {
    agent,
    threadId: target.threadId,
    historical: false,
    hit: {
      row_id: 0,
      segment_id: "head",
      thread_id: target.threadId,
      artifact_id: target.artifactId,
      operation_id: target.publicationId,
      excerpt: "",
    },
  };
}

export const closedLibraryState = {
  ...closedCollaboratorsState,
  library_open: false,
  library_project_id: undefined,
  library_entry_id: undefined,
};
