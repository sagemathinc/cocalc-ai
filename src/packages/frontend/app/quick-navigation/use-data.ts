/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import {
  getVisibleSettingsNavigation,
  useSettingsNavigationContext,
} from "@cocalc/frontend/account/settings-navigation";
import { getRegisteredSettingsPageDefinition } from "@cocalc/frontend/account/settings-page-registry";
import { useBookmarkedProjects } from "@cocalc/frontend/projects/use-bookmarked-projects";
import { recentFilesFromLog } from "@cocalc/frontend/projects/recent-files";
import { FIXED_PROJECT_TABS } from "@cocalc/frontend/project/page/file-tab";
import { filterTabsForProjectAccess } from "@cocalc/frontend/project/page/fixed-tab-access";
import { useProjectRuntimeCapabilities } from "@cocalc/frontend/project/runtime-capabilities";
import type { FixedTab } from "@cocalc/frontend/project/page/fixed-tab-ids";
import { lite } from "@cocalc/frontend/lite";
import { isIntlMessage, labels } from "@cocalc/frontend/i18n";
import { getLogger } from "@cocalc/frontend/logger";
import { CONAT_BOOKMARKS_KEY } from "@cocalc/util/consts/bookmarks";
import { filename_extension, path_to_tab } from "@cocalc/util/misc";
import { redux_name } from "@cocalc/util/redux/name";
import { get_local_storage } from "@cocalc/frontend/misc/local-storage";
import { get_file_editor } from "@cocalc/frontend/frame-editors/frame-tree/register";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { toAbsoluteProjectPath } from "@cocalc/frontend/project/sync-path";
import { recentActivity } from "./recent-activity";
import type { AppPage, Candidate, Editor } from "./model";
import { settingsKeywords } from "./settings-keywords";
import { frameLayout } from "./frames";

const logger = getLogger("quick-navigation");
const plain = (value: any) => value?.toJS?.() ?? value;
const asArray = (value: any): string[] =>
  Array.isArray(value) ? value : (value?.toArray?.() ?? []);
function loadedProject(id: string) {
  return redux.hasProjectStore(id) ? redux.getProjectStore(id) : undefined;
}
function fileRuntime(project: any, path: string) {
  const info = plain(project?.getIn(["open_files", path, "component"]));
  return {
    info,
    store: info?.redux_name ? redux.getStore(info.redux_name) : undefined,
  };
}
// Editors persist their layout in localStorage under their redux name, so a
// tab that was restored lazily (no editor store yet) or a file that is not
// open still has a layout to preview. Frame ids are the ones the editor will
// restore, so navigating to them works after the file opens.
function savedViewState(project: any, projectId: string, path: string) {
  const syncPath = project?.getIn(["open_files", path, "sync_path"]) ?? path;
  try {
    const raw = get_local_storage(redux_name(projectId, syncPath));
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.frame_tree ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function editorSpec(info: any, path: string) {
  return (
    info?.Editor?.editor_spec ??
    get_file_editor(filename_extension(path).toLowerCase())?.component
      ?.editor_spec
  );
}

// Mounted only while the dialog is open. Subscribe to loaded stores, including
// inactive projects/editors, without opening projects or fetching their logs.
export function useNavigationData() {
  const intl = useIntl();
  const projects = useTypedRedux("projects", "project_map");
  const openProjects = useTypedRedux("projects", "open_projects");
  const activeProject = useTypedRedux("page", "active_top_tab");
  const computeVmEnabled =
    useTypedRedux("customize", "compute_vm_enabled") === true;
  const runtime = useProjectRuntimeCapabilities();
  const accountId = useTypedRedux("account", "account_id");
  // CoCalc-ai has public/signed-in users, but no upstream anonymous-account
  // state. Treat the legacy noAnonymous metadata as requiring sign-in here.
  const signedIn =
    useTypedRedux("account", "user_type") === "signed_in" || lite;
  const isAdmin = asArray(useTypedRedux("account", "groups")).includes("admin");
  const settingsContext = useSettingsNavigationContext();
  const { bookmarkedProjects } = useBookmarkedProjects();
  const [version, setVersion] = useState(0);
  const [stars, setStars] = useState<Record<string, string[]>>({});
  const projectIds = useMemo(
    () => projects?.keySeq().toArray() ?? [],
    [projects],
  );

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions = new Set<any>();
    const changed = () => {
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = undefined;
        reconcile();
        setVersion((v) => v + 1);
      }, 50);
    };
    function reconcile() {
      if (closed) return;
      const next = new Set<any>();
      for (const id of projectIds) {
        const project = loadedProject(id);
        if (!project) continue;
        next.add(project);
        for (const path of asArray(project.get("open_files_order"))) {
          const store = fileRuntime(project, path).store;
          if (store) next.add(store);
        }
      }
      for (const store of subscriptions)
        if (!next.has(store)) {
          store.removeListener("change", changed);
          subscriptions.delete(store);
        }
      for (const store of next)
        if (!subscriptions.has(store)) {
          store.on("change", changed);
          subscriptions.add(store);
        }
    }
    reconcile();
    return () => {
      closed = true;
      clearTimeout(timer);
      for (const store of subscriptions)
        store.removeListener("change", changed);
    };
  }, [projectIds, openProjects]);

  useEffect(() => {
    let closed = false;
    let cleanup: (() => void) | undefined;
    setStars({});
    if (accountId)
      void (async () => {
        try {
          const dkv = await getSharedAccountDkv<string[]>({
            account_id: accountId,
            name: CONAT_BOOKMARKS_KEY,
          });
          if (closed) return;
          const update = () => setStars(dkv.getAll());
          dkv.on("change", update);
          cleanup = () => dkv.removeListener("change", update);
          update();
        } catch (err) {
          logger.debug("starred files unavailable", err);
        }
      })();
    return () => {
      closed = true;
      cleanup?.();
    };
  }, [accountId]);

  const items: Candidate[] = [];
  let currentEditor: Editor | undefined;
  const activity = recentActivity();
  // Tabs remembered for projects closed in earlier sessions. Together with the
  // activity history this keeps recent files searchable after a refresh, even
  // when no project is open yet.
  const closedSession: { [projectId: string]: string[] } =
    redux.getActions("page")?.closed_session_files?.() ?? {};
  for (const id of projectIds) {
    const title = String(projects?.getIn([id, "title"]) || id);
    const isCurrent = id === activeProject;
    const isOpen = openProjects?.includes(id);
    const priority = isCurrent
      ? 0
      : isOpen
        ? 10
        : bookmarkedProjects.includes(id)
          ? 20
          : 30;
    const project = loadedProject(id);
    // In the current project the files come first: you are already there.
    // Elsewhere the project entry leads its files.
    items.push({
      id: `project:${id}`,
      title,
      detail: "Project",
      priority: isCurrent ? priority + 3 : priority,
      destination: { kind: "project", projectId: id },
    });
    // One entry per file. Open tabs, starred files and log entries may spell
    // the same file relative or absolute, so dedupe on the absolute path but
    // keep the open tab's own key for store lookups and navigation.
    const home = getProjectHomeDirectory(id);
    const absolute = (path: string) => toAbsoluteProjectPath(path, home);
    const files = new Map<
      string,
      { path: string; open?: number; starred?: boolean; recent?: number }
    >();
    const merge = (path: string, state: object) => {
      const key = absolute(path);
      const current = files.get(key);
      files.set(key, { path: current?.path ?? path, ...current, ...state });
    };
    asArray(project?.get("open_files_order")).forEach((path, index) =>
      merge(path, { open: index + 1 }),
    );
    for (const path of Array.isArray(stars[id]) ? stars[id] : [])
      merge(path, { starred: true });
    for (const path of asArray(closedSession[id])) merge(path, {});
    for (const path of Object.keys(activity[id] ?? {})) merge(path, {});
    for (const recent of recentFilesFromLog(project?.get("project_log"), 100)) {
      const time = new Date(recent.time).getTime();
      merge(recent.filename, { recent: Number.isFinite(time) ? time : 0 });
    }
    for (const state of files.values()) {
      const { path } = state;
      const { store, info } = fileRuntime(project, path);
      const local =
        plain(store?.get("local_view_state")) ??
        savedViewState(project, id, path);
      const { frames, layout } = frameLayout(
        local?.frame_tree,
        editorSpec(info, path),
        intl,
      );
      const editor: Editor = {
        projectId: id,
        path,
        frames,
        layout,
        activeId: local?.active_id,
      };
      if (isCurrent && project?.get("active_project_tab") === path_to_tab(path))
        currentEditor = editor;
      const detail = `${title} › ${path} · ${state.open ? "Open" : state.starred ? "Starred" : "Recent"}`;
      // Most recently used first: this browser's activation history, then the
      // project log's open time, then tab order for open files.
      const used = activity[id]?.[path];
      items.push({
        id: `file:${id}:${path}`,
        title: path.split("/").pop() || path,
        detail,
        priority: priority + (state.open ? 0 : state.starred ? 1 : 2),
        recent: used ?? state.recent ?? (state.open ? -state.open : undefined),
        destination: { kind: "file", projectId: id, path },
        editor,
      });
    }
    if (isOpen || isCurrent) {
      // Offer exactly the pages the activity bar can open for this project.
      const projectsStore: any = redux.getStore("projects");
      const available = new Set(
        filterTabsForProjectAccess({
          agentAIEnabled:
            projectsStore?.hasLanguageModelEnabled?.(id, "agent") === true,
          computeVmEnabled,
          liteMode: lite,
          names: Object.keys(FIXED_PROJECT_TABS) as FixedTab[],
          rootfsEnabled: runtime.rootfs,
          viewer: projectsStore?.get_my_group?.(id) === "viewer",
        }),
      );
      for (const [page, config] of Object.entries(FIXED_PROJECT_TABS)) {
        if (!available.has(page as FixedTab)) continue;
        if (!signedIn && config.noAnonymous) continue;
        const label = config.label;
        items.push({
          id: `page:${id}:${page}`,
          title: isIntlMessage(label)
            ? intl.formatMessage(label)
            : typeof label === "string"
              ? label
              : page,
          detail: `${title} › Project`,
          priority: priority + 5,
          destination: {
            kind: "project-page",
            projectId: id,
            page: page as FixedTab,
          },
        });
      }
    }
  }
  for (const node of getVisibleSettingsNavigation(settingsContext)) {
    for (const page of node.type === "group" ? node.pages : [node]) {
      const definition = getRegisteredSettingsPageDefinition(page.page);
      const title = definition
        ? intl.formatMessage(definition.label)
        : "Account settings";
      items.push({
        id: `settings:${page.page}`,
        title,
        detail: `Account › ${node.type === "group" ? intl.formatMessage(node.label) : "Settings"}`,
        keywords: definition
          ? settingsKeywords(intl, [
              definition.description,
              ...(definition.controls ?? []),
            ])
          : "preferences",
        priority: 40,
        destination: { kind: "settings", page: page.page },
      });
    }
  }
  // Pages of the top navigation bar, under the same conditions the bar uses
  // to show them. Lite has no top bar apart from account and admin.
  const appPages: {
    page: AppPage;
    title: string;
    keywords: string;
    show: boolean;
  }[] = [
    {
      page: "projects",
      title: intl.formatMessage(labels.projects),
      keywords: "all projects list collaborate",
      show: signedIn && !lite,
    },
    {
      page: "hosts",
      title: "Compute",
      keywords: "hosts project hosts virtual machines vm servers",
      show: signedIn && !lite,
    },
    {
      page: "notifications",
      title: intl.formatMessage(labels.notifications),
      keywords: "mentions news invitations",
      show: signedIn && !lite,
    },
    {
      page: "admin",
      title: intl.formatMessage(labels.admin),
      keywords: "site settings users administration",
      show: signedIn && isAdmin,
    },
  ];
  for (const { page, title, keywords, show } of appPages)
    if (show)
      items.push({
        id: `app:${page}`,
        title,
        detail: "Navigation bar",
        keywords,
        priority: 35,
        destination: { kind: "app-page", page },
      });
  items.push({
    id: "docs",
    title: "Documentation",
    detail: "Quick Navigation help",
    priority: 40,
    destination: {
      kind: "docs",
      projectId: projectIds.includes(activeProject) ? activeProject : undefined,
    },
  });
  // version is the subscription revision; reading stores above intentionally
  // rebuilds the snapshot when another project's editor state changes.
  void version;
  return {
    items,
    currentEditor,
    projectId: projectIds.includes(activeProject) ? activeProject : undefined,
  };
}
