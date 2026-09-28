/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Button, Tabs } from "antd";
import { useState } from "react";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { ProjectThemeAvatar } from "@cocalc/frontend/projects/theme";
import { VirtualCollectionList } from "@cocalc/frontend/components/virtual-collection";
import type { MouseEvent } from "react";
import type {
  CollaborationResource,
  CollaborationResourceKind,
} from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import { useDirectory } from "./use-directory";
import { DirectoryResults } from "./directory-results";
import { ResourceList } from "./resource-list";
import { ReplaceRoomDialog } from "./replace-room-dialog";
import { PersonAliasControl } from "./person-alias-control";

export function Overview({
  api,
  accountId,
  projectId,
  personId,
  onProject,
  onPerson,
  onResource,
  onNewConversation,
  onInvite,
  onManageProject,
  onPersonAliasChange,
}: {
  api: DirectoryApi;
  accountId: string;
  projectId?: string;
  personId?: string;
  onProject: (id: string, event: MouseEvent<HTMLElement>) => void;
  onPerson: (id: string, event: MouseEvent<HTMLElement>) => void;
  onResource: (
    resource: CollaborationResource,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onNewConversation: () => void;
  onInvite: () => void;
  onManageProject: (projectId: string) => void;
  onPersonAliasChange?: (alias: string | null) => void;
}) {
  const [replacingRoom, setReplacingRoom] = useState(false);
  const projects = useDirectory(
    JSON.stringify(["overview-projects", projectId, personId]),
    (after) =>
      api.listProjects({
        shared_only: true,
        project_id: projectId,
        person_id: personId,
        after,
        limit: 25,
      }),
  );
  const people = useDirectory(
    JSON.stringify(["overview-people", projectId, personId]),
    (after) =>
      api.listPeople({
        project_id: projectId,
        person_id: personId,
        after,
        limit: 25,
      }),
  );
  const person = personId
    ? people.page?.items.find((p) => p.account_id === personId)
    : undefined;
  const project =
    !personId && projectId
      ? projects.page?.items.find((p) => p.project_id === projectId)
      : undefined;
  return (
    <div className="collaborators-overview">
      <div className="collaborators-overview-identity">
        {person ? (
          <Avatar
            account_id={person.account_id}
            display_name={person.display_name}
            size={40}
            no_tooltip
          />
        ) : project ? (
          <ProjectThemeAvatar theme={project.theme} size={40} border />
        ) : null}
        <div>
          <h2>
            {personId
              ? person?.display_name || "Person overview"
              : project?.title || "Project overview"}
          </h2>
          {person && (
            <PersonAliasControl
              compact
              accountId={accountId}
              personId={person.account_id}
              api={api}
              onChange={onPersonAliasChange}
              onResolve={onPersonAliasChange}
            />
          )}
        </div>
      </div>
      {!personId && (
        <p>
          {project?.description ||
            "People and work in this project. Browsing does not start project compute."}
        </p>
      )}
      <div className="collaborators-actions">
        <Button type="primary" onClick={onNewConversation}>
          Start discussion
        </Button>
        <Button onClick={onInvite}>
          {personId ? "Invite to projects" : "Invite collaborator"}
        </Button>
        {project && (
          <Button onClick={() => onManageProject(project.project_id)}>
            Settings
          </Button>
        )}
        {project?.role === "owner" && (
          <Button onClick={() => setReplacingRoom(true)}>
            Replace deleted conversation room
          </Button>
        )}
      </div>
      {replacingRoom && project?.role === "owner" && (
        <ReplaceRoomDialog
          key={`${accountId}:${project.project_id}`}
          api={api}
          accountId={accountId}
          projectId={project.project_id}
          projectTitle={project.title}
          onClose={() => setReplacingRoom(false)}
          onStart={() => {
            setReplacingRoom(false);
            onNewConversation();
          }}
        />
      )}
      {personId ? (
        <>
          <DirectoryResults
            label="Shared projects"
            result={projects}
            heading={<h3>Shared projects</h3>}
            empty="No shared projects to show."
          >
            {(items) => (
              <VirtualCollectionList
                className="collaborators-list"
                items={items}
                itemId={(item) => item.project_id}
                renderItem={(item) => (
                  <Button
                    type="text"
                    className="collaborators-row collaborators-person-row"
                    onClick={(event) => onProject(item.project_id, event)}
                  >
                    <ProjectThemeAvatar theme={item.theme} size={24} border />{" "}
                    {item.title || "Untitled project"}
                  </Button>
                )}
              />
            )}
          </DirectoryResults>
          {people.error && (
            <DirectoryResults label="Person" result={people}>
              {() => null}
            </DirectoryResults>
          )}
        </>
      ) : (
        <>
          {projects.error && (
            <DirectoryResults label="Project" result={projects}>
              {() => null}
            </DirectoryResults>
          )}
          <DirectoryResults
            heading={<h3>People</h3>}
            label="Project people"
            result={people}
            empty="No other collaborators. Invite someone to work together in this project."
          >
            {(items) => (
              <VirtualCollectionList
                className="collaborators-list"
                items={items}
                itemId={(item) => item.account_id}
                renderItem={(item) => (
                  <Button onClick={(event) => onPerson(item.account_id, event)}>
                    <Avatar
                      account_id={item.account_id}
                      display_name={item.display_name}
                      size={24}
                      no_tooltip
                    />{" "}
                    {item.display_name || "Collaborator"}
                  </Button>
                )}
              />
            )}
          </DirectoryResults>
        </>
      )}
      {personId ? (
        <Tabs
          aria-label="Related work"
          defaultActiveKey="conversation"
          destroyOnHidden
          items={(["conversation", "agent", "artifact"] as const).map(
            (kind) => ({
              key: kind,
              label: resourceLabel(kind),
              children: (
                <ResourceSection
                  key={JSON.stringify([kind, projectId, personId])}
                  api={api}
                  kind={kind}
                  projectId={projectId}
                  personId={personId}
                  onOpen={onResource}
                />
              ),
            }),
          )}
        />
      ) : (
        (["conversation", "agent", "artifact"] as const).map((kind) => (
          <ResourceSection
            key={JSON.stringify([kind, projectId, personId])}
            api={api}
            kind={kind}
            projectId={projectId}
            personId={personId}
            onOpen={onResource}
          />
        ))
      )}
    </div>
  );
}

function resourceLabel(kind: CollaborationResourceKind) {
  return kind === "conversation"
    ? "Conversations"
    : kind === "agent"
      ? "Agents"
      : "Artifacts";
}

function ResourceSection({
  api,
  kind,
  projectId,
  personId,
  onOpen,
}: {
  api: DirectoryApi;
  kind: CollaborationResourceKind;
  projectId?: string;
  personId?: string;
  onOpen: (
    resource: CollaborationResource,
    event: MouseEvent<HTMLElement>,
  ) => void;
}) {
  const [ownerIndexed, setOwnerIndexed] = useState(false);
  const result = useDirectory(
    JSON.stringify([kind, projectId, personId, ownerIndexed]),
    (after) => {
      const query = {
        kind,
        project_id: projectId,
        person_id: personId,
        after,
        limit: 25,
      };
      return ownerIndexed && projectId
        ? api.listProjectResources({ ...query, project_id: projectId })
        : api.listResources({ ...query, scope: "all" });
    },
  );
  const label = resourceLabel(kind);
  return (
    <>
      {projectId &&
        (ownerIndexed ||
          (result.page && result.page.coverage !== "complete")) && (
          <div>
            <p>
              {ownerIndexed
                ? "Reading this selected project's owner index, independently of account index capacity. Unindexed sources may still be absent; search uses shared titles, not personal aliases."
                : "Account indexing is incomplete. You can browse this project's owner indexed work without waiting for the account index."}
            </p>
            <Button onClick={() => setOwnerIndexed((value) => !value)}>
              {ownerIndexed
                ? `Use account index for ${label.toLowerCase()}`
                : `Browse owner indexed ${label.toLowerCase()}`}
            </Button>
          </div>
        )}
      <DirectoryResults
        heading={
          personId ? (
            <span className="collaborators-person-meta">
              {kind === "conversation"
                ? "Conversations involving this person"
                : "Related work you can access"}
            </span>
          ) : (
            <h3>{ownerIndexed ? `Owner indexed work: ${label}` : label}</h3>
          )
        }
        result={result}
        label={ownerIndexed ? `Owner indexed ${label.toLowerCase()}` : label}
        empty={
          kind === "conversation"
            ? "No conversations to show yet. Start a discussion in a shared project."
            : `No ${label.toLowerCase()} to show.`
        }
      >
        {(items) => <ResourceList items={items} onOpen={onOpen} />}
      </DirectoryResults>
    </>
  );
}
