/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { ProjectSettingsDrawer } from "@cocalc/frontend/agents/project-settings-drawer";
import type { MouseEvent } from "react";
import { Map as ImmutableMap } from "immutable";
import { Alert, Button } from "antd";
import { useCollectionPreferences } from "@cocalc/frontend/components/use-collection-preferences";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationPerson,
  CollaborationProject,
  CollaborationResource,
  CollaborationResourceQuery,
} from "@cocalc/util/collaborators";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { boundCollaboratorsApi } from "./workspace-api";
import type { DirectoryApi } from "./workspace-api";
import {
  DirectoryRevisionContext,
  useDirectoryRevision,
} from "./use-directory-revision";
import { useDirectory, useDirectorySearch } from "./use-directory";
import { DirectoryResults, DirectoryResultOptions } from "./directory-results";
import { DirectorySplitView } from "./directory-split-view";
import {
  canonicalizeCollaboratorsAlias,
  withCollaboratorsAlias,
} from "./navigation";
import { ProjectList } from "./project-pins";
import { PEOPLE_VIEWS as VIEWS, WorkspaceToolbar } from "./workspace-toolbar";
import { DirectoryPicker } from "./directory-picker";
import { ResourceList } from "./resource-list";
import { DirectoryCollection } from "./directory-collection";
import { Overview } from "./overview";
import { ResourceDetail } from "./resource-detail";
import { HumanConversationSearch } from "./conversation-search";
import type { ConversationSearchHit } from "../chat/conversation-search/runner";
import { NewConversation } from "./new-conversation";
import { InvitationHistory } from "./invitation-history";
import { boundPeopleHistoryApi } from "./people-history-api";
import { ContactOverview, PeopleContacts } from "./people-contacts";
import type { PeopleContact } from "@cocalc/util/people-invitation-history";
import type { InviteProjectsDraft } from "./invitation-api";
import type { CollaboratorInvitePerson } from "./add-collaborators";
import type {
  CollaboratorsPageProps,
  CollaboratorsRoute,
  ProjectView,
} from "./workspace-types";
import "./page.css";

export type {
  CollaboratorsPageProps,
  CollaboratorsRoute,
  CollaboratorsView,
} from "./workspace-types";

const InviteProjects = lazy(async () => ({
  default: (await import("./invite-projects")).InviteProjects,
}));
const NewProjectCreator = lazy(async () => ({
  default: (await import("@cocalc/frontend/projects/create-project"))
    .NewProjectCreator,
}));

export function CollaboratorsPage(props: CollaboratorsPageProps) {
  const signedIn = useTypedRedux("account", "account_id");
  const projects = useTypedRedux("projects", "project_map");
  // Immutable Redux values are not plain objects. Membership changes invalidate
  // both catalog metadata and mounted content, rather than merely refreshing rows.
  const accessKey =
    projects
      ?.entrySeq?.()
      .map(([id, project]) => {
        const member = project.getIn(["users", props.accountId]);
        const plain = ImmutableMap.isMap(member) ? member.toObject() : member;
        const group =
          typeof plain === "string"
            ? plain
            : plain && typeof plain === "object" && "group" in plain
              ? plain.group
              : undefined;
        return JSON.stringify([id, group ?? project.get("group") ?? null]);
      })
      .sort()
      .join(",") ?? "";
  const server = typeof location === "undefined" ? "" : location.origin;
  if (props.routeError)
    return (
      <section
        style={{ padding: 20, display: props.active ? undefined : "none" }}
      >
        {props.navigation}
        <Alert
          role="alert"
          type="error"
          title="Invalid People link"
          description={props.routeError}
        />
        <Button onClick={() => props.onNavigate({ view: "conversations" })}>
          Open People
        </Button>
      </section>
    );
  if (!props.accountId || signedIn !== props.accountId)
    return (
      <p role="status" hidden={!props.active}>
        Sign in to browse your collaborators.
      </p>
    );
  return (
    <AccountCollaboratorsPage
      key={JSON.stringify([server, props.accountId, accessKey])}
      {...props}
    />
  );
}

function AccountCollaboratorsPage(props: CollaboratorsPageProps) {
  const [api] = useState(() => boundCollaboratorsApi(props.accountId));
  const view = props.view ?? "conversations";
  const selected =
    props.resourceId ||
    (view === "people"
      ? (props.contactId ?? props.personId)
      : view === "projects"
        ? props.projectId
        : undefined);
  // Match the retained list filters while a detail pane is selected: the
  // resource locator must not put the still-visible global list to sleep.
  const demandList = useRef({
    view,
    projects: props.projectIds ?? (props.projectId ? [props.projectId] : []),
  });
  if (!selected || demandList.current.view !== view)
    demandList.current = {
      view,
      projects: props.projectIds ?? (props.projectId ? [props.projectId] : []),
    };
  const demandProjects = demandList.current.projects.length
    ? [
        ...new Set([
          ...demandList.current.projects,
          ...(selected && props.projectId ? [props.projectId] : []),
        ]),
      ].sort()
    : [];
  const revision = useDirectoryRevision(
    api,
    props.active,
    view === "invites"
      ? undefined
      : demandProjects.length
        ? { kind: "projects", project_ids: demandProjects }
        : { kind: "all" },
  );
  return (
    <DirectoryRevisionContext.Provider value={revision}>
      <CollaboratorsWorkspace {...props} api={api} revision={revision} />
    </DirectoryRevisionContext.Provider>
  );
}

function CollaboratorsWorkspace({
  accountId,
  active,
  navigation,
  headerActions,
  view = "conversations",
  projectId,
  projectIds,
  personId,
  contactId,
  invitationId,
  resourceKind,
  resourceId,
  onNavigate,
  api,
  revision,
}: CollaboratorsPageProps & {
  api: DirectoryApi;
  revision: ReturnType<typeof useDirectoryRevision>;
}) {
  const [input, setInput] = useState("");
  const [searchHit, setSearchHit] = useState<ConversationSearchHit>();
  const search = useDirectorySearch(input);
  const [scope, setScope] =
    useState<NonNullable<CollaborationResourceQuery["scope"]>>("for-you");
  const [projectView, setProjectView] = useState<ProjectView>("recent");
  const [pinRevision, setPinRevision] = useState(0);
  const pinFocus = useRef<string | undefined>(undefined);
  const [picker, setPicker] = useState<"project" | "person" | "conversation">();
  const [inviteProjects, setInviteProjects] = useState<string[]>();
  const [invitePerson, setInvitePerson] = useState<CollaboratorInvitePerson>();
  const [historyApi] = useState(() => boundPeopleHistoryApi(accountId));
  const invitationDraft = useRef<InviteProjectsDraft | undefined>(undefined);
  const inviteSelection = useRef<string[]>([]);
  const [createProject, setCreateProject] = useState<
    "invite" | "conversation"
  >();
  const [newProject, setNewProject] = useState<{ id: string; title: string }>();
  const [error, setError] = useState("");
  const [settingsProject, setSettingsProject] = useState<string>();
  const [createdResourceId, setCreatedResourceId] = useState<string>();
  const toolbarId = useId();
  const [panelControls, setPanelControls] = useState<HTMLDivElement | null>(
    null,
  );
  const [conversationToolbar, setConversationToolbar] =
    useState<HTMLDivElement | null>(null);
  const conversationOpen = !!resourceId && resourceKind === "conversation";
  const preferences = useCollectionPreferences(view);
  const [filterNames, setFilterNames] = useState<Record<string, string>>({});
  const projects = useTypedRedux("projects", "project_map");
  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const scrollPosition = useRef({ list: 0, page: 0 });
  const returnRoute = useRef<CollaboratorsRoute | undefined>(undefined);
  const route: CollaboratorsRoute = {
    view,
    projectId,
    projectIds,
    personId,
    contactId,
    invitationId,
    resourceKind,
    resourceId,
  };
  const selection = resourceId
    ? JSON.stringify([resourceKind, projectId, resourceId])
    : view === "people"
      ? (contactId ?? personId)
      : view === "projects"
        ? projectId
        : undefined;
  // The selected resource's project is a locator, not a new list filter.
  const listRoute = useRef({ view, projectId, projectIds, personId });
  if (!selection || listRoute.current.view !== view)
    listRoute.current = { view, projectId, projectIds, personId };
  const listProjectId = listRoute.current.projectId;
  const listProjectIds =
    listRoute.current.projectIds ?? (listProjectId ? [listProjectId] : []);
  const listPersonId = listRoute.current.personId;
  const projectFilters = listProjectIds.map((id) => {
    const title =
      revision.ready && (filterNames[id] || projects?.getIn([id, "title"]));
    return {
      id,
      title: typeof title === "string" && title ? title : "Project",
    };
  });
  const selectedProjectTitle = projectId
    ? projects?.getIn([projectId, "title"])
    : undefined;
  const queryKey = JSON.stringify([
    view,
    search,
    listProjectIds,
    listPersonId,
    scope,
    projectView,
    pinRevision,
  ]);
  const result = useDirectory<
    CollaborationResource | CollaborationPerson | CollaborationProject
  >(
    queryKey,
    (after) => {
      const opts = {
        shared_only: true,
        search,
        project_ids: listProjectIds.length ? listProjectIds : undefined,
        person_id: listPersonId,
        after,
        limit: 50,
      };
      if (view === "people") return api.listPeople(opts);
      if (view === "projects")
        return api.listProjects({ ...opts, view: projectView });
      return api.listResources({
        ...opts,
        kind: scope === "collected" ? undefined : "conversation",
        scope,
      });
    },
    active && view !== "invites",
  );

  useEffect(() => {
    if (selection && active) detailRef.current?.focus();
  }, [selection, active]);

  useEffect(() => {
    if (!pinFocus.current || result.loading || !active || selection) return;
    if (view !== "projects") {
      pinFocus.current = undefined;
      return;
    }
    const button = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-collection-pin]") ??
        [],
    ).find((item) => item.dataset.collectionPin === pinFocus.current);
    (button ?? listRef.current)?.focus({ preventScroll: true });
    pinFocus.current = undefined;
  }, [result.loading, result.page, active, selection, view]);

  function navigate(next: CollaboratorsRoute, event?: MouseEvent<HTMLElement>) {
    if (event) trigger.current = event.currentTarget;
    if (!selection) {
      returnRoute.current = route;
      scrollPosition.current = {
        list: listRef.current?.scrollTop ?? 0,
        page: listRef.current?.closest(".collaborators-page")?.scrollTop ?? 0,
      };
    }
    onNavigate({ ...next, projectIds: listProjectIds });
  }
  function filter(next: CollaboratorsRoute) {
    listRoute.current = {
      view: next.view,
      projectId: next.projectId,
      projectIds: next.projectIds,
      personId: next.personId,
    };
    returnRoute.current = undefined;
    onNavigate(next);
  }
  function back() {
    setSearchHit(undefined);
    onNavigate(
      returnRoute.current ?? {
        view,
        projectIds: listProjectIds,
        projectId: view === "projects" ? undefined : projectId,
        personId: view === "people" ? undefined : personId,
        contactId: undefined,
      },
    );
    requestAnimationFrame(() => {
      const target = trigger.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else listRef.current?.focus();
      if (listRef.current)
        listRef.current.scrollTop = scrollPosition.current.list;
      const page = listRef.current?.closest(".collaborators-page");
      if (page) page.scrollTop = scrollPosition.current.page;
    });
  }
  function openResource(
    resource: CollaborationResource,
    event: MouseEvent<HTMLElement>,
  ) {
    setSearchHit(undefined);
    navigate(
      withCollaboratorsAlias(
        {
          ...route,
          projectId: resource.project_id,
          resourceKind: resource.kind,
          resourceId: resource.resource_id,
        },
        resource.personal?.alias,
      ),
      event,
    );
  }
  function invite() {
    invitationDraft.current = undefined;
    setInvitePerson(undefined);
    setInviteProjects(projectId ? [projectId] : []);
  }
  function inviteContact(contact: PeopleContact) {
    invitationDraft.current = undefined;
    setInvitePerson(
      contact.linked_account_id
        ? {
            account_id: contact.linked_account_id,
            display_name: contact.display_label || "Invited person",
          }
        : contact.email
          ? { email_address: contact.email }
          : undefined,
    );
    setInviteProjects(projectId ? [projectId] : []);
  }
  function newConversation() {
    // Always offer shared projects for a person's overview, never a private DM.
    if (!projectId) {
      setPicker("conversation");
      return;
    }
    const project = result.page?.items.find(
      (item) => "project_id" in item && item.project_id === projectId,
    );
    const title =
      project && "kind" in project
        ? project.project_title
        : project && "description" in project
          ? project.title
          : undefined;
    setNewProject({ id: projectId, title: title || "the selected project" });
  }
  async function manageProject(id: string) {
    try {
      await ensureProjectReduxRuntime();
      if (redux.getStore("account")?.get("account_id") !== accountId) return;
      setSettingsProject(id);
    } catch (error) {
      setError(String(error));
    }
  }

  return (
    <KeyboardBoundary
      boundary="collaborators"
      className="collaborators-page"
      data-detail={!!selection}
      data-conversation={conversationOpen}
      style={{
        background: UI_COLORS.page,
        color: UI_COLORS.text,
        display: active ? undefined : "none",
      }}
    >
      <header
        className="collaborators-header"
        style={{ borderBottom: `1px solid ${UI_COLORS.border}` }}
      >
        <div className="collaborators-heading">
          {navigation}
          <h1>People</h1>
        </div>
        <WorkspaceToolbar
          resultOptions={<DirectoryResultOptions result={result} inline />}
          conversationSearch={
            <HumanConversationSearch
              api={api}
              accountId={accountId}
              active={active}
              projects={
                projects
                  ?.entrySeq()
                  .toArray()
                  .map(([id, project]) => ({
                    value: id,
                    label: project.get("title") || "Untitled project",
                  })) ?? []
              }
              onSelect={(resource, hit) => {
                setSearchHit({ ...hit });
                navigate(
                  withCollaboratorsAlias(
                    {
                      view: "conversations",
                      projectId: resource.project_id,
                      resourceKind: "conversation",
                      resourceId: resource.resource_id,
                    },
                    resource.personal?.alias,
                  ),
                );
              }}
            />
          }
          compact={conversationOpen}
          controlsTarget={conversationOpen ? conversationToolbar : null}
          active={active}
          id={toolbarId}
          view={view}
          onView={(view) =>
            onNavigate({
              view,
              projectIds: listProjectIds,
              personId: listPersonId,
            })
          }
          input={input}
          onInput={setInput}
          scope={scope}
          onScope={setScope}
          projectView={projectView}
          onProjectView={setProjectView}
          preferences={preferences}
          projectFilters={projectFilters}
          personLabel={
            listPersonId
              ? (revision.ready && filterNames[listPersonId]) || "Person"
              : undefined
          }
          onProjectFilter={() => setPicker("project")}
          onPersonFilter={() => setPicker("person")}
          onClearProject={(id) =>
            filter({
              view,
              personId: listPersonId,
              projectIds: listProjectIds.filter((value) => value !== id),
            })
          }
          onClearPerson={() => filter({ view, projectIds: listProjectIds })}
          onAction={view === "conversations" ? newConversation : invite}
        />
        <div className="collaborators-header-actions">
          <div
            className="collaborators-panel-controls"
            ref={setPanelControls}
          />
          {headerActions}
        </div>
        {preferences.error && (
          <Alert
            role="alert"
            type="error"
            title={preferences.error}
            action={<Button onClick={preferences.retry}>Retry save</Button>}
          />
        )}
      </header>
      {active &&
        !revision.ready &&
        (revision.error ? (
          <Alert
            role="alert"
            type="error"
            title="Unable to refresh collaboration access"
            description={revision.error}
            action={
              <Button onClick={revision.retry}>Retry access check</Button>
            }
          />
        ) : (
          <p role="status">Checking collaboration access...</p>
        ))}
      {error && (
        <Alert
          role="alert"
          type="error"
          title="Unable to open project"
          description={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {view === "invites" ? (
        <div
          role="tabpanel"
          id={`${toolbarId}-panel-invites`}
          aria-labelledby={`${toolbarId}-tab-invites`}
          style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
          tabIndex={0}
        >
          <InvitationHistory
            api={historyApi}
            collectionView={preferences.value.view}
            invitationId={invitationId}
            onClearInvitation={() =>
              onNavigate({ ...route, invitationId: undefined })
            }
            active={active}
            personId={contactId}
            participantAccountId={personId}
            search={search}
            projectIds={listProjectIds}
            projectTitle={(id) => {
              const title = projects?.getIn([id, "title"]);
              return typeof title === "string" ? title : undefined;
            }}
            onOpen={(row) => {
              const target =
                row.kind === "collaboration" ? row.target : undefined;
              onNavigate(
                target
                  ? {
                      view: "conversations",
                      projectId: target.project_id,
                      resourceKind: target.kind,
                      resourceId: target.resource_id,
                    }
                  : { view: "projects", projectId: row.project_id },
              );
            }}
          />
        </div>
      ) : (
        <DirectorySplitView
          hasDetail={!!selection}
          selectionKey={selection}
          controlsTarget={panelControls}
          id={`${toolbarId}-panel-${view}`}
          labelledBy={`${toolbarId}-tab-${view}`}
        >
          <div
            className="collaborators-results"
            ref={listRef}
            tabIndex={-1}
            aria-label="People results"
          >
            {conversationOpen && (
              <div
                className="collaborators-conversation-toolbar"
                ref={setConversationToolbar}
              />
            )}
            <DirectoryResults
              hideOptions
              result={result}
              onRestart={
                view === "projects"
                  ? () => {
                      listRef.current?.focus();
                      setPinRevision((value) => value + 1);
                    }
                  : undefined
              }
              label={VIEWS.find(([key]) => key === view)![1]}
              empty={
                view === "people"
                  ? "No collaborators match this scope. Invite someone to an existing project or create a project to work together."
                  : view === "projects"
                    ? projectView === "pinned"
                      ? "No pinned projects match. Pin a project from Recent projects or clear your filters."
                      : "No shared projects match. Invite a collaborator or clear your filters."
                    : "No conversations match this filter."
              }
            >
              {(items) =>
                view === "conversations" ? (
                  <ResourceList
                    items={items as CollaborationResource[]}
                    onOpen={openResource}
                    api={api}
                    preferences={preferences}
                    compact={conversationOpen}
                    selectedId={
                      resourceId && resourceKind && projectId
                        ? collaborationTargetKey({
                            project_id: projectId,
                            kind: resourceKind,
                            resource_id: resourceId,
                          })
                        : undefined
                    }
                  />
                ) : view === "projects" ? (
                  <ProjectList
                    items={items as CollaborationProject[]}
                    api={api}
                    preferences={preferences}
                    onOpen={(project, event) =>
                      navigate(
                        {
                          view: "projects",
                          projectId: project.project_id,
                          personId,
                        },
                        event,
                      )
                    }
                    onPinChange={(id) => {
                      pinFocus.current =
                        document.activeElement?.getAttribute(
                          "data-collection-pin",
                        ) === id
                          ? id
                          : undefined;
                      // Restart at page one: the favorite-set-bound cursor is now stale.
                      setPinRevision((value) => value + 1);
                    }}
                  />
                ) : (
                  <DirectoryCollection
                    items={items as CollaborationPerson[]}
                    collection="people"
                    viewOverride={selection ? "list" : undefined}
                    label="People"
                    preferences={preferences}
                    itemId={(item) => item.account_id}
                    itemTitle={(item) => item.display_name || "Collaborator"}
                    renderItem={(item) => (
                      <Button
                        type="text"
                        className="collaborators-row collaborators-person-row"
                        onClick={(event) =>
                          navigate(
                            {
                              view: "people",
                              projectId,
                              personId: item.account_id,
                            },
                            event,
                          )
                        }
                      >
                        <Avatar
                          account_id={item.account_id}
                          display_name={item.display_name}
                          size={40}
                          no_tooltip
                        />
                        <span>
                          <span className="collaborators-row-title">
                            {item.display_name || "Collaborator"}
                          </span>
                          <span className="collaborators-person-meta">
                            {item.common_project_count} shared{" "}
                            {item.common_project_count === 1
                              ? "project"
                              : "projects"}
                          </span>
                        </span>
                      </Button>
                    )}
                  />
                )
              }
            </DirectoryResults>
            {view === "people" && !listPersonId && !listProjectIds.length && (
              <PeopleContacts
                api={historyApi}
                active={active}
                search={search}
                onSelect={(contact) =>
                  navigate({ view: "people", contactId: contact.person_id })
                }
              />
            )}
          </div>
          {selection && (
            <div
              className="collaborators-detail"
              ref={detailRef}
              tabIndex={-1}
              aria-label="Selected collaboration"
              style={{
                background: UI_COLORS.surface,
                borderLeft: `1px solid ${UI_COLORS.border}`,
              }}
            >
              {(!conversationOpen || !revision.ready) && (
                <div>
                  <Button onClick={back}>Back to results</Button>
                </div>
              )}
              {active &&
                revision.ready &&
                (contactId ? (
                  <ContactOverview
                    key={contactId}
                    api={historyApi}
                    contactId={contactId}
                    onInvite={inviteContact}
                    onOpen={(row) =>
                      onNavigate({
                        view: "projects",
                        projectId: row.project_id,
                      })
                    }
                    projectTitle={(id) => {
                      const title = projects?.getIn([id, "title"]);
                      return typeof title === "string" ? title : undefined;
                    }}
                  />
                ) : resourceId && resourceKind && projectId ? (
                  <ResourceDetail
                    searchHit={searchHit}
                    key={JSON.stringify([projectId, resourceKind, resourceId])}
                    api={api}
                    accountId={accountId}
                    awaitingIndex={createdResourceId === resourceId}
                    onResolved={() => {
                      if (createdResourceId !== resourceId) return;
                      // The initial refresh can beat directory ingestion. Once
                      // detail lookup confirms it, do not wait for the next poll.
                      setCreatedResourceId(undefined);
                      result.refresh();
                    }}
                    target={{
                      project_id: projectId,
                      kind: resourceKind,
                      resource_id: resourceId,
                    }}
                    onChange={result.refresh}
                    onAlias={(alias) => {
                      void canonicalizeCollaboratorsAlias(
                        accountId,
                        route,
                        alias,
                      );
                    }}
                    onBack={back}
                    onManageProject={(id) => void manageProject(id)}
                    projectTitle={
                      typeof selectedProjectTitle === "string"
                        ? selectedProjectTitle
                        : undefined
                    }
                  />
                ) : (
                  <>
                    <Overview
                      accountId={accountId}
                      key={JSON.stringify([projectId, personId])}
                      api={api}
                      projectId={projectId}
                      personId={personId}
                      onProject={(id, event) =>
                        navigate(
                          { view: "projects", projectId: id, personId },
                          event,
                        )
                      }
                      onPerson={(id, event) =>
                        navigate(
                          { view: "people", projectId, personId: id },
                          event,
                        )
                      }
                      onResource={openResource}
                      onNewConversation={newConversation}
                      onInvite={invite}
                      onPersonAliasChange={(alias) => {
                        void canonicalizeCollaboratorsAlias(
                          accountId,
                          route,
                          alias,
                        );
                      }}
                      onManageProject={(id) => void manageProject(id)}
                    />
                    <InvitationHistory
                      api={historyApi}
                      participantAccountId={personId}
                      projectIds={projectId ? [projectId] : undefined}
                      active={active}
                      onOpen={(row) =>
                        onNavigate({
                          view: "projects",
                          projectId: row.project_id,
                        })
                      }
                      projectTitle={(id) => {
                        const title = projects?.getIn([id, "title"]);
                        return typeof title === "string" ? title : undefined;
                      }}
                    />
                  </>
                ))}
            </div>
          )}
        </DirectorySplitView>
      )}
      {active && picker && (
        <DirectoryPicker
          api={api}
          kind={picker === "person" ? "person" : "project"}
          sharedOnly
          title={
            picker === "conversation"
              ? "Choose a project for the conversation"
              : `Filter by ${picker}`
          }
          projectId={projectId}
          projectIds={listProjectIds}
          selectedProjects={projectFilters}
          onSelectProjects={
            picker === "project"
              ? (items) => {
                  setFilterNames((names) => ({
                    ...names,
                    ...Object.fromEntries(
                      items.map(({ id, title }) => [id, title]),
                    ),
                  }));
                  filter({
                    view,
                    personId: listPersonId,
                    projectIds: items.map(({ id }) => id),
                  });
                  setPicker(undefined);
                }
              : undefined
          }
          personId={personId}
          onClose={() => setPicker(undefined)}
          onCreateProject={
            picker === "conversation"
              ? () => {
                  setCreateProject(picker);
                  setPicker(undefined);
                }
              : undefined
          }
          onSelect={(item) => {
            setFilterNames((names) => ({ ...names, [item.id]: item.title }));
            if (picker === "conversation") setNewProject(item);
            else
              filter({
                ...route,
                resourceId: undefined,
                resourceKind: undefined,
                projectId: undefined,
                projectIds: listProjectIds,
                personId: item.id,
              });
            setPicker(undefined);
          }}
        />
      )}
      <ProjectSettingsDrawer
        projectId={settingsProject}
        open={active && !!settingsProject}
        onClose={() => setSettingsProject(undefined)}
      />
      {active && inviteProjects && (
        <Suspense
          fallback={<p role="status">Loading project invitations...</p>}
        >
          <InviteProjects
            initialProjectIds={inviteProjects}
            initialDraft={invitationDraft.current}
            person={
              invitePerson ??
              (personId
                ? {
                    account_id: personId,
                    display_name: filterNames[personId] || "Collaborator",
                  }
                : undefined)
            }
            onClose={() => setInviteProjects(undefined)}
            onCreateProject={(selected, draft) => {
              inviteSelection.current = selected;
              invitationDraft.current = draft;
              setInviteProjects(undefined);
              setCreateProject("invite");
            }}
          />
        </Suspense>
      )}
      {active && createProject && (
        <Suspense fallback={<p role="status">Loading project creation...</p>}>
          <NewProjectCreator
            default_value=""
            open
            onClose={() => {
              if (createProject === "invite")
                setInviteProjects(inviteSelection.current);
              setCreateProject(undefined);
            }}
            onCreated={(id) => {
              setCreateProject(undefined);
              if (createProject === "conversation")
                setNewProject({ id, title: "the new project" });
              else {
                // The creator calls onClose after onCreated; both must restore
                // the selection that includes the newly created project.
                inviteSelection.current = [...inviteSelection.current, id];
                if (invitationDraft.current)
                  invitationDraft.current = {
                    ...invitationDraft.current,
                    createdProjectIds: [
                      ...invitationDraft.current.createdProjectIds,
                      id,
                    ],
                  };
                setInviteProjects(inviteSelection.current);
              }
              result.refresh();
            }}
          />
        </Suspense>
      )}
      {active && newProject && (
        <NewConversation
          api={api}
          accountId={accountId}
          project={newProject}
          onManageProject={() => void manageProject(newProject.id)}
          onChangeProject={() => {
            setNewProject(undefined);
            setPicker("conversation");
          }}
          onClose={() => setNewProject(undefined)}
          onCreated={(resource) => {
            setCreatedResourceId(resource.resource_id);
            setNewProject(undefined);
            result.refresh();
            navigate({
              ...route,
              projectId: resource.project_id,
              resourceKind: "conversation",
              resourceId: resource.resource_id,
            });
          }}
        />
      )}
    </KeyboardBoundary>
  );
}
