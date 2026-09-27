/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Button, Input, Popover } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { CollectionViewControl } from "@cocalc/frontend/components/collection";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { CollaborationResourceQuery } from "@cocalc/util/collaborators";
import type { CollaboratorsView, ProjectView } from "./workspace-types";
import type { DirectoryCollectionPreferences } from "./directory-collection";
import { ProjectViewControls } from "./project-pins";

export const PEOPLE_VIEWS: [CollaboratorsView, string][] = [
  ["conversations", "Conversations"],
  ["people", "Collaborators"],
  ["projects", "Shared projects"],
];
const SCOPES = {
  "for-you": "For you",
  following: "Following",
  all: "All accessible",
  collected: "My collection",
};

export function WorkspaceToolbar({
  active,
  id,
  view,
  onView,
  input,
  onInput,
  scope,
  onScope,
  projectView,
  onProjectView,
  preferences,
  projectLabel,
  personLabel,
  onProjectFilter,
  onPersonFilter,
  onClearProject,
  onClearPerson,
  onAction,
}: {
  active: boolean;
  id: string;
  view: CollaboratorsView;
  onView: (view: CollaboratorsView) => void;
  input: string;
  onInput: (value: string) => void;
  scope: NonNullable<CollaborationResourceQuery["scope"]>;
  onScope: (value: NonNullable<CollaborationResourceQuery["scope"]>) => void;
  projectView: ProjectView;
  onProjectView: (view: ProjectView) => void;
  preferences: DirectoryCollectionPreferences;
  projectLabel?: string;
  personLabel?: string;
  onProjectFilter: () => void;
  onPersonFilter: () => void;
  onClearProject: () => void;
  onClearPerson: () => void;
  onAction: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<ComponentRef<typeof Button>>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    setFiltersOpen(false);
  }, [view, active]);
  useEffect(() => {
    if (filtersOpen) filterPanel.current?.focus();
  }, [filtersOpen]);
  const search = `Search ${view === "people" ? "collaborators" : view}`;
  const action =
    view === "conversations"
      ? "New conversation"
      : view === "people"
        ? "Invite"
        : "Invite to project";
  const filters = [
    projectLabel && {
      label: projectLabel,
      name: "Clear project filter",
      clear: onClearProject,
    },
    personLabel && {
      label: personLabel,
      name: "Clear person filter",
      clear: onClearPerson,
    },
    view === "conversations" &&
      scope !== "all" && {
        label: SCOPES[scope],
        name: "Clear conversation filter",
        clear: () => onScope("all"),
      },
    view === "projects" &&
      projectView === "pinned" && {
        label: "Pinned projects",
        name: "Clear pinned projects filter",
        clear: () => onProjectView("recent"),
      },
  ].filter(
    (item): item is { label: string; name: string; clear: () => void } =>
      !!item,
  );
  function pick(action: () => void) {
    setFiltersOpen(false);
    // The picker must return focus to a persistent control, not this popover.
    filterButton.current?.focus();
    action();
  }
  return (
    <>
      <div
        role="tablist"
        aria-label="People views"
        className="collaborators-tabs"
      >
        {PEOPLE_VIEWS.map(([key, label], index) => (
          <button
            type="button"
            role="tab"
            key={key}
            id={`${id}-tab-${key}`}
            aria-controls={view === key ? `${id}-panel-${key}` : undefined}
            aria-selected={view === key}
            tabIndex={view === key ? 0 : -1}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            className="collaborators-tab"
            style={{
              color: view === key ? UI_COLORS.link : UI_COLORS.secondary,
              borderBottomColor: view === key ? UI_COLORS.link : "transparent",
            }}
            onClick={() => onView(key)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % PEOPLE_VIEWS.length
                  : event.key === "ArrowLeft"
                    ? (index + PEOPLE_VIEWS.length - 1) % PEOPLE_VIEWS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? PEOPLE_VIEWS.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              tabs.current[next]?.focus();
              onView(PEOPLE_VIEWS[next][0]);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="collaborators-list-controls">
        <div className="collaborators-toolbar">
          <Input
            className="collaborators-search"
            aria-label={search}
            prefix={<Icon name="search" />}
            value={input}
            maxLength={200}
            onChange={(event) => onInput(event.target.value)}
            placeholder={`${search}...`}
          />
          <Popover
            trigger="click"
            placement="bottomRight"
            open={active && filtersOpen}
            onOpenChange={setFiltersOpen}
            destroyOnHidden
            fresh
            content={
              <KeyboardBoundary boundary="people-filters">
                {filtersOpen && active && (
                  <div
                    ref={filterPanel}
                    role="dialog"
                    aria-label="People filters"
                    tabIndex={-1}
                    className="collaborators-filters"
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setFiltersOpen(false);
                      filterButton.current?.focus();
                    }}
                  >
                    {view !== "projects" && (
                      <Button onClick={() => pick(onProjectFilter)}>
                        {projectLabel
                          ? "Change project filter"
                          : "Filter by project"}
                      </Button>
                    )}
                    {view !== "people" && (
                      <Button onClick={() => pick(onPersonFilter)}>
                        {personLabel
                          ? "Change person filter"
                          : "Filter by person"}
                      </Button>
                    )}
                    {view === "projects" && (
                      <ProjectViewControls
                        view={projectView}
                        onChange={onProjectView}
                      />
                    )}
                    {view === "conversations" && (
                      <>
                        <label htmlFor={`${id}-scope`}>Show</label>
                        <select
                          id={`${id}-scope`}
                          value={scope}
                          style={{
                            color: UI_COLORS.text,
                            background: UI_COLORS.surface,
                            border: `1px solid ${UI_COLORS.controlBorder}`,
                            padding: 6,
                            borderRadius: 6,
                          }}
                          onChange={(event) =>
                            onScope(event.target.value as typeof scope)
                          }
                        >
                          {Object.entries(SCOPES).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {scope === "for-you" && (
                          <small>
                            Mentions, followed conversations, and conversations
                            you participated in.
                          </small>
                        )}
                        {scope === "collected" && (
                          <small>
                            Saved conversations, agents, and artifacts. Removing
                            a shortcut never deletes the original.
                          </small>
                        )}
                      </>
                    )}
                  </div>
                )}
              </KeyboardBoundary>
            }
          >
            <Button
              ref={filterButton}
              aria-label="Filters"
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              icon={<Icon name="sliders" />}
            >
              Filters
            </Button>
          </Popover>
          <CollectionViewControl
            view={preferences.value.view}
            onChange={preferences.setView}
            label={
              view === "people"
                ? "People"
                : view === "projects"
                  ? "Projects"
                  : "Conversations"
            }
          />
          <Button type="primary" icon={<Icon name="plus" />} onClick={onAction}>
            {action}
          </Button>
        </div>
        {!!filters.length && (
          <div
            className="collaborators-filter-chips"
            aria-label="Active filters"
          >
            {filters.map(({ label, name, clear }) => (
              <Button
                key={name}
                size="small"
                aria-label={`${name}: ${label}`}
                onClick={() => {
                  clear();
                  filterButton.current?.focus();
                }}
              >
                {label} <Icon name="times" />
              </Button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
