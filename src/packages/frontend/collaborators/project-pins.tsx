/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Alert, Button } from "antd";
import type { CollaborationProject } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import type { ProjectView } from "./workspace-types";
import { DirectoryCollection } from "./directory-collection";
import { ProjectThemeAvatar } from "@cocalc/frontend/projects/theme";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export function ProjectViewControls({
  view,
  onChange,
}: {
  view: ProjectView;
  onChange: (view: ProjectView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Project view"
      className="collaborators-actions"
    >
      <Button
        aria-pressed={view === "recent"}
        onClick={() => onChange("recent")}
      >
        Recent projects
      </Button>
      <Button
        aria-pressed={view === "pinned"}
        onClick={() => onChange("pinned")}
      >
        Pinned projects
      </Button>
      <small>
        Pins are your existing project favorites, not access grants.
      </small>
    </div>
  );
}

export function ProjectList({
  items,
  api,
  onOpen,
  onPinChange,
}: {
  items: CollaborationProject[];
  api: DirectoryApi;
  onOpen: (
    project: CollaborationProject,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onPinChange: (project_id: string) => void;
}) {
  return (
    <DirectoryCollection
      items={items}
      collection="projects"
      label="Projects"
      itemStyle={(project) => ({
        borderColor: project.theme?.color || UI_COLORS.border,
        background: project.theme?.accent_color
          ? `linear-gradient(130deg, color-mix(in srgb, ${project.theme.accent_color} 12%, ${UI_COLORS.surface}), ${UI_COLORS.surface})`
          : UI_COLORS.surface,
      })}
      itemId={(project) => project.project_id}
      itemTitle={(project) => project.title || "Untitled project"}
      pinLabel={(project) => `project ${project.title || "Untitled project"}`}
      isPinned={(project) => !!project.pinned}
      onPin={async (project, pinned) => {
        await api.setProjectPinned({ project_id: project.project_id, pinned });
        onPinChange(project.project_id);
      }}
      renderItem={(project) => (
        <Button
          type="text"
          className="collaborators-row"
          onClick={(event) => onOpen(project, event)}
        >
          <ProjectThemeAvatar theme={project.theme} size={40} border />
          <span className="collaborators-row-title">
            {project.title || "Untitled project"}
          </span>
          <span>{project.description}</span>
          <span>
            {project.role === "owner" ? "Owner" : "Collaborator"}
            {project.last_activity_at
              ? ` · Active ${new Date(project.last_activity_at).toLocaleDateString()}`
              : ""}
          </span>
        </Button>
      )}
    />
  );
}

export function ProjectPinControl({
  project,
  api,
  onChange,
}: {
  project: CollaborationProject;
  api: DirectoryApi;
  onChange: (project_id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function toggle() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await api.setProjectPinned({
        project_id: project.project_id,
        pinned: !project.pinned,
      });
      onChange(project.project_id);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const action = project.pinned ? "Unpin" : "Pin";
  return (
    <div className="collaborators-actions">
      <Button
        aria-label={`${action} project ${project.title || "Untitled project"}`}
        aria-pressed={!!project.pinned}
        aria-disabled={busy}
        data-project-pin={project.project_id}
        onClick={() => void toggle()}
      >
        {action} project
      </Button>
      {busy && <span role="status">Saving project pin...</span>}
      {error && (
        <Alert
          role="alert"
          type="error"
          title="Unable to save project pin"
          description={error}
        />
      )}
    </div>
  );
}
