/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The workspace sidebar in projects mode (sidebar navigation): pinned
// projects (the starred ones, drag to reorder) and recently used ones. This
// replaces the project tabs; recently visited projects stay open in the
// background (see app/project-retention).

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { moveVisibleCollectionPin } from "@cocalc/frontend/components/collection-order";
import {
  SidebarDot,
  SidebarList,
  type SidebarListItem,
} from "@cocalc/frontend/components/sidebar-list";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ProjectThemeAvatar } from "./theme";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { requestNewProject } from "./new-project-request";

const RECENT = 15;
const MATCHES = 50;
// In a sidebar section, which shows a few and links to the full page.
const SECTION_RECENT = 3;

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
  recentLimit = RECENT,
  current,
}: {
  project_map: any;
  account_id?: string;
  pins: string[];
  search?: string;
  recentLimit?: number;
  // The open project: always listed, even when it is not recent.
  current?: string;
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
  const limit = needle ? MATCHES : recentLimit;
  const recent = others.slice(0, limit).map(({ item }) => item);
  const open = others.find(({ item }) => item.project_id === current);
  if (open && !recent.includes(open.item)) recent.push(open.item);
  return {
    pinned,
    recent,
    more: Math.max(0, others.length - recent.length),
  };
}

export function ProjectsSidebar({
  search,
  inSection = false,
  onlyCurrent = false,
  onNavigate,
}: {
  // From the sidebar's search box.
  search: string;
  // Shown as a sidebar section: fewer recent items and no list heading.
  inSection?: boolean;
  // Only the open item, for a collapsed sidebar section.
  onlyCurrent?: boolean;
  onNavigate?: () => void;
}) {
  const actions = useActions("projects");
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const current = useTypedRedux("page", "active_top_tab");
  const {
    bookmarkedProjects,
    setProjectBookmarked,
    setBookmarkedProjectsOrder,
  } = useBookmarkedProjects();
  const { pinned, recent, more } = sidebarProjects({
    project_map,
    account_id,
    pins: bookmarkedProjects,
    search,
    recentLimit: onlyCurrent ? 0 : inSection ? SECTION_RECENT : RECENT,
    current,
  });

  function open(project_id: string, e?: React.MouseEvent) {
    actions.open_project({
      project_id,
      switch_to: !(e?.button === 1 || e?.ctrlKey || e?.metaKey),
    });
    onNavigate?.();
  }

  const item = (project: SidebarProject): SidebarListItem => ({
    id: project.project_id,
    title: project.title,
    current: project.project_id === current,
    avatar: (
      <ProjectThemeAvatar
        project={project_map?.get(project.project_id)}
        size={26}
      />
    ),
    extra: project.running ? (
      <SidebarDot color={UI_COLORS.success} label="Running" />
    ) : undefined,
  });

  return (
    <SidebarList
      showLabel={!inSection}
      onlyCurrent={onlyCurrent}
      label="Projects"
      itemLabel="project"
      newLabel="New Project"
      onNew={() => {
        requestNewProject();
        void actions.redux.getActions("page").set_active_tab("projects");
        onNavigate?.();
      }}
      search={search}
      pinned={pinned.map(item)}
      recent={recent.map(item)}
      more={more}
      onOpen={open}
      onPin={(id, pin) => setProjectBookmarked(id, pin)}
      onMovePin={(visible, id, index) =>
        setBookmarkedProjectsOrder(
          moveVisibleCollectionPin(bookmarkedProjects, visible, id, index),
        )
      }
      onAll={() => {
        void actions.redux.getActions("page").set_active_tab("projects");
        onNavigate?.();
      }}
    />
  );
}
