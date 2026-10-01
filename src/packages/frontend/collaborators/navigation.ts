import { redux } from "@cocalc/frontend/app-framework";
import type { CollaboratorsRoute } from "./workspace-types";
import { normalizePrivateAlias } from "@cocalc/util/private-alias";
import { collaboratorsTargetPath } from "./routing";
import {
  cancelPersonalUrlNavigation,
  closedPersonalUrlState,
} from "@cocalc/frontend/personal-url-state";
import { resolvePersonalUrl } from "@cocalc/frontend/personal-url-navigation";

let navigationRevision = 0;
let canonicalizationRevision = 0;
export function cancelAliasNavigation() {
  cancelPersonalUrlNavigation();
  return ++navigationRevision;
}

export function collaboratorsRouteState(
  route: Partial<CollaboratorsRoute> = {},
) {
  return {
    collaborators_view: route.view ?? "conversations",
    collaborators_project_id: route.projectId,
    collaborators_project_ids: route.projectIds,
    collaborators_person_id: route.personId,
    collaborators_contact_id: route.contactId,
    collaborators_invitation_id:
      route.view === "invites" ? route.invitationId : undefined,
    collaborators_resource_kind: route.resourceKind,
    collaborators_resource_id: route.resourceId,
    collaborators_alias: route.alias,
    collaborators_alias_kind: route.aliasKind,
    collaborators_alias_owner: route.aliasOwner,
  };
}

export const closedCollaboratorsState = {
  ...closedPersonalUrlState,
  collaborators_open: false,
  collaborators_view: undefined,
  collaborators_project_id: undefined,
  collaborators_project_ids: undefined,
  collaborators_person_id: undefined,
  collaborators_contact_id: undefined,
  collaborators_invitation_id: undefined,
  collaborators_resource_kind: undefined,
  collaborators_resource_id: undefined,
  collaborators_route_error: undefined,
  collaborators_alias: undefined,
  collaborators_alias_kind: undefined,
  collaborators_alias_owner: undefined,
};

/** Keep stable selection/context; invalid legacy free-form labels use the ID URL. */
export function withCollaboratorsAlias(
  route: CollaboratorsRoute,
  alias?: string | null,
): CollaboratorsRoute {
  const next = {
    ...route,
    alias: undefined,
    aliasKind: undefined,
    aliasOwner: undefined,
  } as CollaboratorsRoute;
  if (!alias || route.contactId || route.view === "invites") return next;
  try {
    const kind =
      route.resourceId &&
      (route.resourceKind === "conversation" || route.resourceKind === "agent")
        ? "chats"
        : !route.resourceId && route.personId
          ? "people"
          : undefined;
    if (kind) {
      next.alias = normalizePrivateAlias(alias);
      next.aliasKind = kind;
      next.aliasOwner = redux.getStore("account")?.get("account_id");
    }
  } catch {
    /* Existing free-form labels need not be valid URL aliases. */
  }
  return next;
}

/** Update only alias metadata and replace the URL. Never reselect/remount a chat. */
export async function canonicalizeCollaboratorsAlias(
  accountId: string,
  route: CollaboratorsRoute,
  alias?: string | null,
): Promise<boolean> {
  const current = () => {
    const page = redux.getStore("page");
    return (
      (!page?.get("personal_url") ||
        page.get("personal_url_owner_account_id") === accountId) &&
      redux.getStore("account")?.get("account_id") === accountId &&
      page?.get("active_top_tab") === "agents" &&
      !page.get("library_open") &&
      page.get("collaborators_open") &&
      page.get("collaborators_view") === route.view &&
      page.get("collaborators_project_id") === route.projectId &&
      page.get("collaborators_person_id") === route.personId &&
      page.get("collaborators_contact_id") === route.contactId &&
      page.get("collaborators_invitation_id") === route.invitationId &&
      page.get("collaborators_resource_kind") === route.resourceKind &&
      page.get("collaborators_resource_id") === route.resourceId
    );
  };
  if (!current()) return false;
  const request = ++canonicalizationRevision;
  const navigation = navigationRevision;
  const { replace_url } = await import("@cocalc/frontend/history");
  // An older label must not win after another save or a leave-and-return.
  if (
    request !== canonicalizationRevision ||
    navigation !== navigationRevision ||
    !current()
  )
    return false;
  const next = withCollaboratorsAlias(route, alias);
  cancelAliasNavigation();
  redux.getActions("page").setState({
    collaborators_alias: next.alias,
    collaborators_alias_kind: next.aliasKind,
    collaborators_alias_owner: next.aliasOwner,
  });
  replace_url(`/${collaboratorsTargetPath(next)}`);
  if (next.alias && next.aliasOwner)
    void resolvePersonalUrl(collaboratorsTargetPath(next), true);
  return true;
}

/** Opening a shared resource is navigation, never an agent invocation. */
export function openCollaborators(route: Partial<CollaboratorsRoute> = {}) {
  const revision = cancelAliasNavigation();
  const resolveAlias =
    route.view !== "invites" &&
    !!route.alias &&
    !!route.aliasKind &&
    !route.personId &&
    !route.contactId &&
    !route.resourceId;
  const page = redux.getActions("page");
  page.setState({
    ...closedPersonalUrlState,
    library_open: false,
    library_project_id: undefined,
    library_entry_id: undefined,
    collaborators_open: true,
    ...collaboratorsRouteState(route),
    collaborators_route_error: resolveAlias
      ? "Resolving personal alias..."
      : undefined,
  });
  if (resolveAlias) void resolveCollaboratorsAlias(route, revision);
  else if (
    route.alias &&
    route.aliasOwner &&
    !route.contactId &&
    route.view !== "invites"
  )
    void resolvePersonalUrl(collaboratorsTargetPath(route), true);
  return page.set_active_tab("agents");
}

/** Resolve without changing history; Back/Forward and login retain the alias URL. */
export async function resolveCollaboratorsAlias(
  route: Partial<CollaboratorsRoute>,
  revision: number,
) {
  if (!route.alias || !route.aliasKind || !route.aliasOwner || route.contactId)
    return;
  if (revision !== navigationRevision) return;
  await resolvePersonalUrl(collaboratorsTargetPath(route));
}
