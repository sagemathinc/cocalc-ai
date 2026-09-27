/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Map as ImmutableMap } from "immutable";
import { Alert, Button, Input } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
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
import { DirectoryResults } from "./directory-results";
import { ProjectList, ProjectViewControls } from "./project-pins";
import { DirectoryPicker } from "./directory-picker";
import { ResourceList } from "./resource-list";
import { Overview } from "./overview";
import { ResourceDetail } from "./resource-detail";
import { NewConversation } from "./new-conversation";
import { CollaboratorsModal } from "./modal";
import type {
  CollaboratorsPageProps,
  CollaboratorsRoute,
  CollaboratorsView,
  ProjectView,
} from "./workspace-types";
import "./page.css";

export type {
  CollaboratorsPageProps,
  CollaboratorsRoute,
  CollaboratorsView,
} from "./workspace-types";

const AddCollaborators = lazy(async () => ({
  default: (await import("./add-collaborators")).AddCollaborators,
}));
const NewProjectCreator = lazy(async () => ({
  default: (await import("@cocalc/frontend/projects/create-project"))
    .NewProjectCreator,
}));
const VIEWS: [CollaboratorsView, string][] = [
  ["conversations", "Conversations"],
  ["people", "People"],
  ["projects", "Projects"],
];

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
          title="Invalid Collaborators link"
          description={props.routeError}
        />
        <Button onClick={() => props.onNavigate({ view: "conversations" })}>
          Open Collaborators
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
  const revision = useDirectoryRevision(api, props.active);
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
  view = "conversations",
  projectId,
  personId,
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
  const search = useDirectorySearch(input);
  const [scope, setScope] =
    useState<CollaborationResourceQuery["scope"]>("for-you");
  const [projectView, setProjectView] = useState<ProjectView>("recent");
  const [pinRevision, setPinRevision] = useState(0);
  const pinFocus = useRef<string | undefined>(undefined);
  const [picker, setPicker] = useState<
    "project" | "person" | "invite" | "conversation"
  >();
  const [inviteProject, setInviteProject] = useState<string>();
  const [createProject, setCreateProject] = useState(false);
  const [newProject, setNewProject] = useState<{ id: string; title: string }>();
  const [error, setError] = useState("");
  const [createdResourceId, setCreatedResourceId] = useState<string>();
  const searchId = useId();
  const scopeId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const scrollPosition = useRef({ list: 0, page: 0 });
  const returnRoute = useRef<CollaboratorsRoute | undefined>(undefined);
  const route: CollaboratorsRoute = {
    view,
    projectId,
    personId,
    resourceKind,
    resourceId,
  };
  const selection = resourceId
    ? JSON.stringify([resourceKind, projectId, resourceId])
    : view === "people"
      ? personId
      : view === "projects"
        ? projectId
        : undefined;
  // The selected resource's project is a locator, not a new list filter.
  const listRoute = useRef({ view, projectId, personId });
  if (!selection || listRoute.current.view !== view)
    listRoute.current = { view, projectId, personId };
  const listProjectId = listRoute.current.projectId;
  const listPersonId = listRoute.current.personId;
  const queryKey = JSON.stringify([
    view,
    search,
    listProjectId,
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
        search,
        project_id: listProjectId,
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
    active,
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
      listRef.current?.querySelectorAll<HTMLElement>("[data-project-pin]") ??
        [],
    ).find((item) => item.dataset.projectPin === pinFocus.current);
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
    onNavigate(next);
  }
  function filter(next: CollaboratorsRoute) {
    listRoute.current = {
      view: next.view,
      projectId: next.projectId,
      personId: next.personId,
    };
    returnRoute.current = undefined;
    onNavigate(next);
  }
  function back() {
    onNavigate(
      returnRoute.current ?? {
        view,
        projectId: view === "projects" ? undefined : projectId,
        personId: view === "people" ? undefined : personId,
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
    navigate(
      {
        ...route,
        projectId: resource.project_id,
        resourceKind: resource.kind,
        resourceId: resource.resource_id,
      },
      event,
    );
  }
  function invite() {
    if (projectId) setInviteProject(projectId);
    else setPicker("invite");
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
      redux.getProjectActions(id)?.set_active_tab("settings");
      await redux.getActions("projects").open_project({ project_id: id });
    } catch (error) {
      setError(String(error));
    }
  }

  return (
    <KeyboardBoundary
      boundary="collaborators"
      className="collaborators-page"
      data-detail={!!selection}
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
        {navigation}
        <h1>Collaborators</h1>
        <p>People, conversations, and work in your shared projects.</p>
        <nav aria-label="Collaborators views" className="collaborators-actions">
          {VIEWS.map(([key, label]) => (
            <Button
              key={key}
              aria-pressed={view === key}
              type={view === key ? "primary" : "default"}
              onClick={() => onNavigate({ view: key, projectId, personId })}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="collaborators-actions">
          <Button onClick={newConversation}>New conversation</Button>
          <Button onClick={invite}>Invite collaborator</Button>
          <Button onClick={() => setCreateProject(true)}>Create project</Button>
        </div>
        <div className="collaborators-list-controls">
          {view === "projects" && (
            <ProjectViewControls view={projectView} onChange={setProjectView} />
          )}
          <label htmlFor={searchId}>Search {view}</label>
          <Input
            id={searchId}
            value={input}
            maxLength={200}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search titles and names"
          />
          <div className="collaborators-actions">
            <Button onClick={() => setPicker("project")}>
              {projectId ? "Change project filter" : "Filter by project"}
            </Button>
            {projectId && (
              <Button
                onClick={() =>
                  filter({
                    ...route,
                    projectId: undefined,
                    resourceId: undefined,
                    resourceKind: undefined,
                  })
                }
              >
                Clear project filter
              </Button>
            )}
            <Button onClick={() => setPicker("person")}>
              {personId ? "Change person filter" : "Filter by person"}
            </Button>
            {personId && (
              <Button onClick={() => filter({ ...route, personId: undefined })}>
                Clear person filter
              </Button>
            )}
            {view === "conversations" && (
              <>
                <label htmlFor={scopeId}>Show</label>
                <select
                  id={scopeId}
                  value={scope}
                  style={{
                    color: UI_COLORS.text,
                    background: UI_COLORS.surface,
                    border: `1px solid ${UI_COLORS.controlBorder}`,
                    padding: 6,
                    borderRadius: 6,
                  }}
                  onChange={(event) =>
                    setScope(
                      event.target.value as CollaborationResourceQuery["scope"],
                    )
                  }
                >
                  <option value="for-you">For you</option>
                  <option value="following">Following</option>
                  <option value="all">All accessible</option>
                  <option value="collected">My collection</option>
                </select>
              </>
            )}
          </div>
          {view === "conversations" && scope === "for-you" && (
            <small>
              Mentions, followed conversations, and conversations you
              participated in. Access does not automatically follow a
              discussion.
            </small>
          )}
          {view === "conversations" && scope === "collected" && (
            <small>
              Saved conversations, agents, and artifacts. Removing a shortcut
              never deletes the original.
            </small>
          )}
        </div>
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
      <div className="collaborators-columns" data-detail={!!selection}>
        <div
          className="collaborators-results"
          ref={listRef}
          tabIndex={-1}
          aria-label="Collaborators results"
        >
          <DirectoryResults
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
                    : "No accessible projects match. Create a project or clear your filters."
                  : "No indexed conversations match. Start a discussion in a project, or try All accessible."
            }
          >
            {(items) =>
              view === "conversations" ? (
                <ResourceList
                  items={items as CollaborationResource[]}
                  onOpen={openResource}
                />
              ) : view === "projects" ? (
                <ProjectList
                  items={items as CollaborationProject[]}
                  api={api}
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
                        "data-project-pin",
                      ) === id
                        ? id
                        : undefined;
                    // Restart at page one: the favorite-set-bound cursor is now stale.
                    setPinRevision((value) => value + 1);
                  }}
                />
              ) : (
                <ul className="collaborators-list">
                  {items.map((item) =>
                    "account_id" in item ? (
                      <li key={item.account_id}>
                        <Button
                          type="text"
                          className="collaborators-row"
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
                          <span className="collaborators-row-title">
                            {item.display_name || "Collaborator"}
                          </span>
                          <span>
                            {item.common_project_count} shared projects
                          </span>
                        </Button>
                      </li>
                    ) : null,
                  )}
                </ul>
              )
            }
          </DirectoryResults>
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
            <div>
              <Button onClick={back}>Back to results</Button>
            </div>
            {active &&
              revision.ready &&
              (resourceId && resourceKind && projectId ? (
                <ResourceDetail
                  key={JSON.stringify([projectId, resourceKind, resourceId])}
                  api={api}
                  accountId={accountId}
                  awaitingIndex={createdResourceId === resourceId}
                  target={{
                    project_id: projectId,
                    kind: resourceKind,
                    resource_id: resourceId,
                  }}
                  onChange={result.refresh}
                  onBack={back}
                />
              ) : (
                <Overview
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
                    navigate({ view: "people", projectId, personId: id }, event)
                  }
                  onResource={openResource}
                  onNewConversation={newConversation}
                  onInvite={invite}
                  onManageProject={(id) => void manageProject(id)}
                />
              ))}
          </div>
        )}
      </div>
      {active && picker && (
        <DirectoryPicker
          api={api}
          kind={picker === "person" ? "person" : "project"}
          title={
            picker === "invite"
              ? "Choose a project to invite to"
              : picker === "conversation"
                ? "Choose a project for the conversation"
                : `Filter by ${picker}`
          }
          projectId={projectId}
          personId={personId}
          onClose={() => setPicker(undefined)}
          onSelect={(item) => {
            if (picker === "invite") setInviteProject(item.id);
            else if (picker === "conversation") setNewProject(item);
            else
              filter({
                ...route,
                resourceId: undefined,
                resourceKind: undefined,
                ...(picker === "project"
                  ? { projectId: item.id }
                  : { personId: item.id }),
              });
            setPicker(undefined);
          }}
        />
      )}
      {active && inviteProject && (
        <CollaboratorsModal
          open
          title="Invite collaborator"
          onCancel={() => setInviteProject(undefined)}
          footer={
            <Button onClick={() => setInviteProject(undefined)}>Close</Button>
          }
        >
          <KeyboardBoundary boundary="collaborators-invite">
            <p>
              Invitations grant access only to this project, not your account or
              other projects.
            </p>
            <Suspense
              fallback={<p role="status">Loading project invitations...</p>}
            >
              <AddCollaborators
                project_id={inviteProject}
                where="collaborators"
                autoFocus
              />
            </Suspense>
          </KeyboardBoundary>
        </CollaboratorsModal>
      )}
      {active && createProject && (
        <Suspense fallback={<p role="status">Loading project creation...</p>}>
          <NewProjectCreator
            default_value=""
            open
            onClose={() => setCreateProject(false)}
            onCreated={(id) => {
              setCreateProject(false);
              setInviteProject(id);
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
