/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Button } from "antd";
import { useState } from "react";
import type { MouseEvent } from "react";
import type {
  CollaborationResource,
  CollaborationResourceKind,
} from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import { useDirectory } from "./use-directory";
import { DirectoryResults } from "./directory-results";
import { ResourceList } from "./resource-list";

export function Overview({
  api,
  projectId,
  personId,
  onProject,
  onPerson,
  onResource,
  onNewConversation,
  onInvite,
  onManageProject,
}: {
  api: DirectoryApi;
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
}) {
  const projects = useDirectory(
    JSON.stringify(["overview-projects", projectId, personId]),
    (after) =>
      api.listProjects({
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
    <div>
      <h2>
        {personId
          ? person?.display_name || "Person overview"
          : project?.title || "Project overview"}
      </h2>
      {personId ? (
        <p>
          Only shared projects and accessible work are shown. Participation and
          creator attribution are different relationships.
        </p>
      ) : (
        <p>
          {project?.description ||
            "People and work in this project. Browsing does not start project compute."}
        </p>
      )}
      <div className="collaborators-actions">
        <Button onClick={onNewConversation}>Start discussion</Button>
        <Button onClick={onInvite}>Invite collaborator</Button>
        {project && (
          <Button onClick={() => onManageProject(project.project_id)}>
            Open project management
          </Button>
        )}
      </div>
      {personId ? (
        <>
          <h3>Shared projects</h3>
          <DirectoryResults label="Shared projects" result={projects}>
            {(items) => (
              <ul className="collaborators-list">
                {items.map((item) => (
                  <li key={item.project_id}>
                    <Button
                      onClick={(event) => onProject(item.project_id, event)}
                    >
                      {item.title || "Untitled project"}
                    </Button>
                  </li>
                ))}
              </ul>
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
          <h3>People</h3>
          <DirectoryResults
            label="Project people"
            result={people}
            empty="No other collaborators. Invite someone to work together in this project."
          >
            {(items) => (
              <ul className="collaborators-list">
                {items.map((item) => (
                  <li key={item.account_id}>
                    <Button
                      onClick={(event) => onPerson(item.account_id, event)}
                    >
                      {item.display_name || "Collaborator"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DirectoryResults>
        </>
      )}
      {(["conversation", "agent", "artifact"] as const).map((kind) => (
        <ResourceSection
          key={JSON.stringify([kind, projectId, personId])}
          api={api}
          kind={kind}
          projectId={projectId}
          personId={personId}
          onOpen={onResource}
        />
      ))}
    </div>
  );
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
  const label =
    kind === "conversation"
      ? "Conversations"
      : kind === "agent"
        ? "Agents"
        : "Artifacts";
  return (
    <>
      <h3>{ownerIndexed ? `Owner indexed work: ${label}` : label}</h3>
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
      {personId && (
        <p>
          {kind === "conversation"
            ? "Conversations involving this person."
            : "Accessible work related to this person; a personal alias is not attribution."}
        </p>
      )}
      <DirectoryResults
        result={result}
        label={ownerIndexed ? `Owner indexed ${label.toLowerCase()}` : label}
        empty={
          kind === "conversation"
            ? "No indexed conversations yet. Start a discussion explicitly; browsing creates no chat file."
            : `No indexed ${label.toLowerCase()} match this scope.`
        }
      >
        {(items) => <ResourceList items={items} onOpen={onOpen} />}
      </DirectoryResults>
    </>
  );
}
