import { redux } from "@cocalc/frontend/app-framework";
import type { CollaboratorsRoute } from "./workspace-types";

export const closedCollaboratorsState = {
  collaborators_open: false,
  collaborators_view: undefined,
  collaborators_project_id: undefined,
  collaborators_person_id: undefined,
  collaborators_resource_kind: undefined,
  collaborators_resource_id: undefined,
  collaborators_route_error: undefined,
};

/** Opening a shared resource is navigation, never an agent invocation. */
export function openCollaborators(route: Partial<CollaboratorsRoute> = {}) {
  const page = redux.getActions("page");
  page.setState({
    library_open: false,
    library_project_id: undefined,
    library_entry_id: undefined,
    collaborators_open: true,
    collaborators_view: route.view ?? "conversations",
    collaborators_project_id: route.projectId,
    collaborators_person_id: route.personId,
    collaborators_resource_kind: route.resourceKind,
    collaborators_resource_id: route.resourceId,
    collaborators_route_error: undefined,
  });
  return page.set_active_tab("agents");
}
