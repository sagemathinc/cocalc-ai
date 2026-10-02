/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The workspace sidebar in projects mode (sidebar navigation): pinned
// projects (the starred ones, drag to reorder) and recently used ones. This
// replaces the project tabs; recently visited projects stay open in the
// background (see app/project-retention).

import { useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Button, Input, Typography } from "antd";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ProjectThemeAvatar } from "./theme";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { requestNewProject } from "./new-project-request";

// Ctrl/Cmd+Shift+P (the project switcher shortcut in classic navigation)
// focuses the filter; it may be requested before the sidebar shows projects.
let focusRequested = false;
const FOCUS_EVENT = "cocalc:focus-projects-filter";
export function focusProjectsFilter(): void {
  focusRequested = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

const RECENT = 15;
const MATCHES = 50;

export interface SidebarProject {
  project_id: string;
  title: string;
  running: boolean;
}

const time = (value: any): number => {
  const t = new Date(value ?? 0).valueOf();
  return Number.isFinite(t) ? t : 0;
};

// Pinned projects in pin order, then the others by when this account last
// used them (then last edited). Hidden and deleted projects are left out
// unless pinned. A search matches titles and descriptions.
export function sidebarProjects({
  project_map,
  account_id,
  pins,
  search = "",
}: {
  project_map: any;
  account_id?: string;
  pins: string[];
  search?: string;
}): { pinned: SidebarProject[]; recent: SidebarProject[]; more: number } {
  const needle = search.trim().toLowerCase();
  const matches = (project) =>
    !needle ||
    `${project.get("title") ?? ""} ${project.get("description") ?? ""}`
      .toLowerCase()
      .includes(needle);
  const item = (project_id: string, project): SidebarProject => ({
    project_id,
    title: project.get("title") || "Untitled",
    running: project.getIn(["state", "state"]) === "running",
  });
  const pinned: SidebarProject[] = [];
  for (const id of pins) {
    const project = project_map?.get(id);
    if (project && !project.get("deleted") && matches(project))
      pinned.push(item(id, project));
  }
  const pinnedIds = new Set(pins);
  const others: { item: SidebarProject; used: number; edited: number }[] = [];
  project_map?.forEach((project, project_id: string) => {
    if (pinnedIds.has(project_id) || project.get("deleted")) return;
    if (account_id && project.getIn(["users", account_id, "hide"])) return;
    if (!matches(project)) return;
    others.push({
      item: item(project_id, project),
      used: time(account_id && project.getIn(["last_active", account_id])),
      edited: time(project.get("last_edited")),
    });
  });
  others.sort((a, b) => b.used - a.used || b.edited - a.edited);
  const limit = needle ? MATCHES : RECENT;
  return {
    pinned,
    recent: others.slice(0, limit).map(({ item }) => item),
    more: Math.max(0, others.length - limit),
  };
}

export function ProjectsSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const actions = useActions("projects");
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const current = useTypedRedux("page", "active_top_tab");
  const {
    bookmarkedProjects,
    setProjectBookmarked,
    setBookmarkedProjectsOrder,
  } = useBookmarkedProjects();
  const [search, setSearch] = useState("");
  const filterRef = useRef<InputRef>(null);
  useEffect(() => {
    const focus = () => {
      if (!focusRequested) return;
      focusRequested = false;
      filterRef.current?.focus();
    };
    focus();
    window.addEventListener(FOCUS_EVENT, focus);
    return () => window.removeEventListener(FOCUS_EVENT, focus);
  }, []);
  const { pinned, recent, more } = sidebarProjects({
    project_map,
    account_id,
    pins: bookmarkedProjects,
    search,
  });

  function open(project_id: string, e?: React.MouseEvent) {
    actions.open_project({
      project_id,
      switch_to: !(e?.button === 1 || e?.ctrlKey || e?.metaKey),
    });
    onNavigate?.();
  }

  function row(project: SidebarProject, isPinned: boolean) {
    const active = project.project_id === current;
    return (
      <div
        role="listitem"
        className="cocalc-agent-sidebar-row"
        style={{
          display: "flex",
          alignItems: "center",
          borderRadius: 6,
          background: active ? UI_COLORS.selected : "transparent",
        }}
      >
        {isPinned && !search ? (
          <span className="cocalc-agent-sidebar-row-reveal">
            <DragHandle
              id={project.project_id}
              ariaLabel={`Drag ${project.title} to reorder`}
              title="Drag to reorder"
              style={{ display: "flex", padding: "10px 6px", cursor: "grab" }}
            />
          </span>
        ) : (
          <span aria-hidden style={{ flex: "0 0 26px" }} />
        )}
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          aria-label={`Open project ${project.title}`}
          title={project.title}
          onClick={(e) => open(project.project_id, e)}
          onAuxClick={(e) => open(project.project_id, e)}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            border: 0,
            background: "transparent",
            color: UI_COLORS.text,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          <ProjectThemeAvatar
            project={project_map?.get(project.project_id)}
            size={26}
          />
          <Typography.Text
            ellipsis
            strong={active}
            style={{ flex: 1, minWidth: 0 }}
          >
            {project.title}
          </Typography.Text>
          {project.running && (
            <span
              title="Running"
              aria-label="Running"
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                flex: "0 0 auto",
                background: UI_COLORS.success,
              }}
            />
          )}
        </button>
        <Button
          className={isPinned ? undefined : "cocalc-agent-sidebar-row-reveal"}
          type="text"
          size="small"
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${project.title}`}
          aria-pressed={isPinned}
          title={isPinned ? "Unpin" : "Pin"}
          icon={
            <Icon
              name={isPinned ? "pushpin-filled" : "pushpin"}
              style={{ color: isPinned ? UI_COLORS.link : UI_COLORS.secondary }}
            />
          }
          onClick={() => setProjectBookmarked(project.project_id, !isPinned)}
        />
      </div>
    );
  }

  const heading = (text: string) => (
    <Typography.Text type="secondary" style={{ display: "block", padding: 6 }}>
      {text}
    </Typography.Text>
  );
  const pinnedIds = pinned.map((p) => p.project_id);

  return (
    <section aria-label="Projects" style={{ paddingRight: 8 }}>
      <Typography.Text
        type="secondary"
        style={{ display: "block", padding: "6px 0 2px" }}
      >
        Projects
      </Typography.Text>
      <Button
        block
        type="text"
        icon={<Icon name="plus" />}
        style={{ justifyContent: "flex-start", marginBottom: 6 }}
        onClick={() => {
          requestNewProject();
          void actions.redux.getActions("page").set_active_tab("projects");
          onNavigate?.();
        }}
      >
        New Project
      </Button>
      <Input
        ref={filterRef}
        type="search"
        allowClear
        aria-label="Filter projects"
        placeholder="Filter projects"
        prefix={<Icon name="search" />}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 6 }}
      />
      {pinned.length > 0 && (
        <>
          {heading("Pinned")}
          <div role="list" aria-label="Pinned projects">
            <SortableList
              items={pinnedIds}
              disabled={!!search}
              onDragStop={(_from, to, id) => {
                if (typeof id === "string")
                  setBookmarkedProjectsOrder(
                    moveVisibleCollectionPin(
                      bookmarkedProjects,
                      pinnedIds,
                      id,
                      to,
                    ),
                  );
              }}
            >
              {pinned.map((project) => (
                <SortableItem
                  key={project.project_id}
                  id={project.project_id}
                  hideActive={false}
                >
                  {row(project, true)}
                </SortableItem>
              ))}
            </SortableList>
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          {heading(search ? "Matches" : "Recent")}
          <div role="list" aria-label="Recent projects">
            {recent.map((project) => (
              <div key={project.project_id}>{row(project, false)}</div>
            ))}
          </div>
        </>
      )}
      {pinned.length === 0 && recent.length === 0 && (
        <Typography.Paragraph type="secondary" style={{ padding: 6 }}>
          {search ? "No matching projects." : "No projects yet."}
        </Typography.Paragraph>
      )}
      <Button
        type="link"
        size="small"
        onClick={() => {
          void actions.redux.getActions("page").set_active_tab("projects");
          onNavigate?.();
        }}
      >
        All projects{more > 0 ? ` (${more} more)` : ""}…
      </Button>
    </section>
  );
}
