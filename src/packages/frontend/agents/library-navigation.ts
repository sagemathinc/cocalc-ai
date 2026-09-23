import { redux } from "@cocalc/frontend/app-framework";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";

/** Library navigation never selects or starts an agent. */
export function openLibrary(projectId?: string, entryId?: string) {
  redux.getActions("page").setState({
    library_open: true,
    library_project_id: projectId,
    library_entry_id: entryId,
  });
  set_url(
    getPageUrlPath({
      page: "agents",
      library: true,
      artifact_project_id: projectId,
      artifact_entry_id: entryId,
    }),
    "",
  );
}

export const closedLibraryState = {
  library_open: false,
  library_project_id: undefined,
  library_entry_id: undefined,
};
