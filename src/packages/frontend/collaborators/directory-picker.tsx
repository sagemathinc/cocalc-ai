/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useId, useState } from "react";
import { Button, Input } from "antd";
import type { DirectoryApi } from "./workspace-api";
import type {
  CollaborationPerson,
  CollaborationProject,
} from "@cocalc/util/collaborators";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { DirectoryResults } from "./directory-results";
import { CollaboratorsModal } from "./modal";
import { useDirectory, useDirectorySearch } from "./use-directory";
import { SelectProject } from "@cocalc/frontend/projects/select-project";

export function DirectoryPicker({
  api,
  kind,
  title,
  projectId,
  personId,
  sharedOnly = false,
  onSelect,
  onClose,
  onCreateProject,
}: {
  api: DirectoryApi;
  kind: "project" | "person";
  title: string;
  projectId?: string;
  personId?: string;
  sharedOnly?: boolean;
  onSelect: (item: { id: string; title: string }) => void;
  onClose: () => void;
  onCreateProject?: () => void;
}) {
  const id = useId();
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
  );
  const [input, setInput] = useState("");
  const search = useDirectorySearch(input);
  const result = useDirectory<CollaborationProject | CollaborationPerson>(
    JSON.stringify([kind, search, projectId, personId, sharedOnly]),
    (after) =>
      kind === "project"
        ? api.listProjects({
            search,
            person_id: personId,
            shared_only: sharedOnly,
            after,
            limit: 25,
          })
        : api.listPeople({ search, project_id: projectId, after, limit: 25 }),
  );
  function restoreFocus() {
    // This picker unmounts immediately, before the modal's closing animation.
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected && document.activeElement === document.body)
        returnFocus.focus({ preventScroll: true });
    });
  }
  function cancel() {
    onClose();
    restoreFocus();
  }
  return (
    <CollaboratorsModal
      open
      title={title}
      onCancel={cancel}
      footer={
        <>
          {onCreateProject && (
            <Button onClick={onCreateProject}>Create project</Button>
          )}
          <Button onClick={cancel}>Cancel</Button>
        </>
      }
    >
      <KeyboardBoundary
        boundary="collaborators-picker"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }}
      >
        {kind === "person" && (
          <>
            <label htmlFor={id}>Search people</label>
            <Input
              id={id}
              autoFocus
              value={input}
              maxLength={200}
              onChange={(e) => setInput(e.target.value)}
            />
          </>
        )}
        {kind === "project" && (
          <SelectProject
            ariaLabel="Search projects"
            autoFocus
            fullCollaboratorOnly
            maxResults={25}
            onSearch={(value) => setInput(value.slice(0, 200))}
            projects={(
              (result.page?.items ?? []) as CollaborationProject[]
            ).map((project) => ({
              id: project.project_id,
              title: project.title || "Untitled",
              group: project.role,
            }))}
            onChange={(id) => {
              const item = (
                result.page?.items as CollaborationProject[] | undefined
              )?.find((project) => project.project_id === id);
              if (!item) return;
              onSelect({ id, title: item.title });
              restoreFocus();
            }}
          />
        )}
        <DirectoryResults
          result={result}
          label={kind === "project" ? "Projects" : "People"}
        >
          {(items) =>
            kind === "project" ? null : (
              <ul className="collaborators-list">
                {items.map((item) => {
                  const id =
                    "project_id" in item ? item.project_id : item.account_id;
                  const title =
                    "title" in item ? item.title : item.display_name;
                  return (
                    <li key={id}>
                      <Button
                        block
                        onClick={() => {
                          onSelect({ id, title });
                          restoreFocus();
                        }}
                      >
                        {title || "Untitled"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )
          }
        </DirectoryResults>
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
