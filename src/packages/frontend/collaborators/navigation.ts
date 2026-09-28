import { redux } from "@cocalc/frontend/app-framework";
import type { CollaboratorsRoute } from "./workspace-types";
import { normalizePrivateAlias } from "@cocalc/util/private-alias";
import { collaboratorsTargetPath } from "./routing";

let navigationRevision = 0;
let canonicalizationRevision = 0;
let stopWatchingAccount: (() => void) | undefined;
export function cancelAliasNavigation() {
  stopWatchingAccount?.();
  stopWatchingAccount = undefined;
  return ++navigationRevision;
}

export function collaboratorsRouteState(
  route: Partial<CollaboratorsRoute> = {},
) {
  return {
    collaborators_view: route.view ?? "conversations",
    collaborators_project_id: route.projectId,
    collaborators_person_id: route.personId,
    collaborators_resource_kind: route.resourceKind,
    collaborators_resource_id: route.resourceId,
    collaborators_alias: route.alias,
    collaborators_alias_kind: route.aliasKind,
  };
}

export const closedCollaboratorsState = {
  collaborators_open: false,
  collaborators_view: undefined,
  collaborators_project_id: undefined,
  collaborators_person_id: undefined,
  collaborators_resource_kind: undefined,
  collaborators_resource_id: undefined,
  collaborators_route_error: undefined,
  collaborators_alias: undefined,
  collaborators_alias_kind: undefined,
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
  } as CollaboratorsRoute;
  if (!alias) return next;
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
      redux.getStore("account")?.get("account_id") === accountId &&
      page?.get("active_top_tab") === "agents" &&
      !page.get("library_open") &&
      page.get("collaborators_open") &&
      page.get("collaborators_view") === route.view &&
      page.get("collaborators_project_id") === route.projectId &&
      page.get("collaborators_person_id") === route.personId &&
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
  const revision = cancelAliasNavigation();
  if (next.alias) watchAliasAccount(next, revision);
  redux.getActions("page").setState({
    collaborators_alias: next.alias,
    collaborators_alias_kind: next.aliasKind,
  });
  replace_url(`/${collaboratorsTargetPath(next)}`);
  return true;
}

/** Opening a shared resource is navigation, never an agent invocation. */
export function openCollaborators(route: Partial<CollaboratorsRoute> = {}) {
  const revision = cancelAliasNavigation();
  const resolveAlias =
    !!route.alias && !!route.aliasKind && !route.personId && !route.resourceId;
  const page = redux.getActions("page");
  page.setState({
    library_open: false,
    library_project_id: undefined,
    library_entry_id: undefined,
    collaborators_open: true,
    ...collaboratorsRouteState(route),
    collaborators_route_error: resolveAlias
      ? "Resolving private alias..."
      : undefined,
  });
  if (resolveAlias) void resolveCollaboratorsAlias(route, revision);
  else if (route.alias) watchAliasAccount(route, revision);
  return page.set_active_tab("agents");
}

/** Resolve without changing history; Back/Forward and login retain the alias URL. */
export async function resolveCollaboratorsAlias(
  route: Partial<CollaboratorsRoute>,
  revision: number,
) {
  if (!route.alias || !route.aliasKind) return;
  if (revision !== navigationRevision) return;
  const accountId = watchAliasAccount(route, revision);
  const current = () =>
    navigationRevision === revision &&
    redux.getStore("account")?.get("account_id") === accountId;
  try {
    if (!accountId) throw Error("Account is not ready");
    const { boundCollaboratorsApi } = await import("./workspace-api");
    if (!current()) return;
    const api = boundCollaboratorsApi(accountId);
    let resolved: Partial<CollaboratorsRoute>;
    if (route.aliasKind === "people") {
      const person = await api.resolvePersonAlias({ alias: route.alias });
      if (!person) throw Error("Person alias unavailable");
      resolved = { view: "people", personId: person.account_id };
    } else {
      const resource = await api.resolveChatAlias({ alias: route.alias });
      if (!resource) throw Error("Chat alias unavailable");
      resolved = {
        view: "conversations",
        projectId: resource.project_id,
        resourceKind: resource.kind,
        resourceId: resource.resource_id,
      };
    }
    if (!current()) return;
    redux.getActions("page").setState({
      ...collaboratorsRouteState({
        ...resolved,
        alias: route.alias,
        aliasKind: route.aliasKind,
      }),
      collaborators_route_error: undefined,
    });
  } catch {
    if (!current()) return;
    redux.getActions("page").setState({
      ...collaboratorsRouteState({
        view: route.view,
        alias: route.alias,
        aliasKind: route.aliasKind,
      }),
      collaborators_route_error:
        "This private alias is unavailable in your account, or you no longer have access.",
    });
  }
}

function watchAliasAccount(
  route: Partial<CollaboratorsRoute>,
  revision: number,
) {
  stopWatchingAccount?.();
  const accountStore = redux.getStore("account");
  const accountId = accountStore?.get("account_id");
  // A resolved alias is private to this account too, not just an in-flight RPC.
  // Keep the URL, but drop its stable selection and resolve afresh on a switch.
  const accountChanged = () => {
    if (revision !== navigationRevision) return;
    if (accountStore.get("account_id") === accountId) return;
    const next = cancelAliasNavigation();
    redux.getActions("page").setState({
      ...collaboratorsRouteState({
        view: route.view,
        alias: route.alias,
        aliasKind: route.aliasKind,
      }),
      collaborators_route_error: "Resolving private alias...",
    });
    void resolveCollaboratorsAlias(route, next);
  };
  accountStore?.on?.("change", accountChanged);
  stopWatchingAccount = () =>
    accountStore?.removeListener?.("change", accountChanged);
  return accountId;
}
