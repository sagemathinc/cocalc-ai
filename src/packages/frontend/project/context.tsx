/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Context,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as immutable from "immutable";
import {
  ProjectActions,
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { UserGroup } from "@cocalc/frontend/projects/store";
import { ProjectStatus } from "@cocalc/frontend/todo-types";
import { LLMServicesAvailable } from "@cocalc/util/db-schema/llm-utils";
import {
  KUCALC_COCALC_COM,
  KUCALC_DISABLED,
} from "@cocalc/util/db-schema/site-defaults";
import { useProject } from "./page/common";
import { FlyoutActiveStarred } from "./page/flyouts/state";
import { useStarredFilesManager } from "./page/flyouts/store";
import {
  init as INIT_PROJECT_STATE,
  useProjectState,
} from "./page/project-state-hook";
import { useProjectHasInternetAccess } from "./settings/has-internet-access-hook";
import { Project } from "./settings/types";
import { lite } from "@cocalc/frontend/lite";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { useProjectCourseInfo } from "./use-project-course";
import {
  pathMatchesRoot,
  selectionForPath,
  useProjectWorkspaces,
} from "./workspaces/state";
import type { ProjectWorkspaceState } from "./workspaces/types";
import { EDITOR_PREFIX, path_to_tab, tab_to_path } from "@cocalc/util/misc";
import {
  notifyProjectFilesystemChange,
  registerProjectFilesystemChangeHandler,
} from "./user-filesystem-change";

type HiddenActiveTabResolution =
  | { kind: "noop" }
  | { kind: "activate-path"; path: string }
  | { kind: "show-files" };

export function resolveHiddenActiveTabForSelection({
  activeProjectTab,
  orderedPaths,
  matchesPath,
}: {
  activeProjectTab?: string;
  orderedPaths: string[];
  matchesPath: (path: string) => boolean;
}): HiddenActiveTabResolution {
  const activePath = tab_to_path(activeProjectTab ?? "");
  if (!activeProjectTab?.startsWith(EDITOR_PREFIX) || !activePath) {
    return { kind: "noop" };
  }
  if (orderedPaths.includes(activePath) && matchesPath(activePath)) {
    return { kind: "noop" };
  }
  const fallbackPath = orderedPaths.find((path) => matchesPath(path));
  return fallbackPath != null
    ? { kind: "activate-path", path: fallbackPath }
    : { kind: "show-files" };
}

export interface ProjectContextState {
  actions?: ProjectActions;
  active_project_tab?: string;
  contentSize: { width: number; height: number };
  enabledLLMs: LLMServicesAvailable;
  flipTabs: [number, React.Dispatch<React.SetStateAction<number>>];
  group?: UserGroup;
  hasInternet?: boolean | undefined;
  is_active: boolean;
  isRunning?: boolean | undefined;
  mainWidthPx: number;
  manageStarredFiles: {
    starred: FlyoutActiveStarred;
    setStarredPath: (path: string, starState: boolean) => void;
  };
  onCoCalcCom: boolean;
  onCoCalcDocker: boolean;
  project_id: string;
  project?: Project;
  notifyUserFilesystemChange: () => void;
  registerUserFilesystemChangeHandler: (
    handler: (() => void) | null | undefined,
  ) => () => void;
  setContentSize: (size: { width: number; height: number }) => void;
  status: ProjectStatus;
  workspaces: ProjectWorkspaceState;
}

export const emptyProjectContext = {
  actions: undefined,
  active_project_tab: undefined,
  contentSize: { width: 0, height: 0 },
  enabledLLMs: {
    openai: false,
    google: false,
    ollama: false,
    mistralai: false,
    anthropic: false,
    custom_openai: false,
    user: false,
  },
  flipTabs: [0, () => {}],
  group: undefined,
  hasInternet: undefined,
  is_active: false,
  isRunning: lite,
  mainWidthPx: 0,
  manageStarredFiles: {
    starred: [],
    setStarredPath: () => {},
  },
  onCoCalcCom: true,
  onCoCalcDocker: false,
  project: undefined,
  project_id: "",
  notifyUserFilesystemChange: () => {},
  registerUserFilesystemChangeHandler: () => () => {},
  setContentSize: () => {},
  status: INIT_PROJECT_STATE,
  workspaces: {
    loading: false,
    records: [],
    selection: { kind: "all" },
    current: null,
    filterPaths: (paths) => [...paths],
    matchesPath: () => true,
    resolveWorkspaceForPath: () => null,
    setSelection: () => {},
    createWorkspace: () => {
      throw new Error("workspaces not initialized");
    },
    updateWorkspace: () => null,
    reorderWorkspaces: () => {},
    deleteWorkspace: () => {},
    touchWorkspace: () => {},
  },
} as ProjectContextState;

export const ProjectContext: Context<ProjectContextState> =
  createContext<ProjectContextState>(emptyProjectContext);

export function useProjectContext() {
  return useContext(ProjectContext);
}

export function useProjectContextProvider({
  project_id,
  is_active,
  mainWidthPx,
}: {
  project_id: string;
  is_active: boolean;
  mainWidthPx: number;
}): ProjectContextState {
  const actions = useActions({ project_id });
  const { project, group } = useProject(project_id);
  useProjectCourseInfo(project_id);
  const account_id = useTypedRedux("account", "account_id");
  const status: ProjectStatus = useProjectState(project_id);
  const hasInternet = useProjectHasInternetAccess(project_id) || lite;
  const hostId = project?.get("host_id") as string | undefined;
  const hostInfo = useHostInfo(hostId);
  const effectiveStatus =
    normalizeProjectStateForDisplay({
      projectState: status.get("state"),
      hostId,
      hostInfo,
    }) ?? status.get("state");
  const isRunning =
    useMemo(() => effectiveStatus === "running", [effectiveStatus]) || lite;
  const active_project_tab = useTypedRedux(
    { project_id },
    "active_project_tab",
  );
  const open_files_order = useTypedRedux({ project_id }, "open_files_order");
  const current_path_abs = useTypedRedux({ project_id }, "current_path_abs");
  // shared data: used to flip through the open tabs in the active files flyout
  const flipTabs = useState<number>(0);

  // manage starred files (active tabs)
  // This is put here, to only sync the starred files when the project is opened,
  // not each time the active tab is opened!
  const manageStarredFiles = useStarredFilesManager(project_id);

  // Sync starred files from conat to Redux store for use in computed values
  useEffect(() => {
    if (actions) {
      actions.setState({
        starred_files: immutable.List(manageStarredFiles.starred),
      });
    }
  }, [manageStarredFiles.starred, actions]);

  const kucalc = useTypedRedux("customize", "kucalc");
  const onCoCalcCom = kucalc === KUCALC_COCALC_COM;
  const onCoCalcDocker = kucalc === KUCALC_DISABLED;

  const haveOpenAI = useTypedRedux("customize", "openai_enabled");
  const haveGoogle = useTypedRedux("customize", "google_vertexai_enabled");
  const haveOllama = useTypedRedux("customize", "ollama_enabled");
  const haveCustomOpenAI = useTypedRedux("customize", "custom_openai_enabled");
  const haveMistral = useTypedRedux("customize", "mistral_enabled");
  const haveAnthropic = useTypedRedux("customize", "anthropic_enabled");
  const userDefinedLLM = useTypedRedux("customize", "user_defined_llm");

  const enabledLLMs = useMemo(() => {
    const projectsStore = redux.getStore("projects");
    return projectsStore.whichLLMareEnabled(project_id);
  }, [
    haveAnthropic,
    haveCustomOpenAI,
    haveGoogle,
    haveMistral,
    haveOllama,
    haveOpenAI,
    userDefinedLLM,
  ]);

  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const workspaces = useProjectWorkspaces(account_id, project_id);
  const previousWorkspaceSelectionRef = useRef<string>("all");
  const previousActivePathRef = useRef<string>("");
  const previousOpenFilesOrderRef = useRef<string[]>([]);
  const workspaceRestorePendingRef = useRef<boolean>(false);
  const workspaceRestoreStableMatchesRef = useRef<number>(0);

  useEffect(() => {
    const activePath = tab_to_path(active_project_tab ?? "");
    if (!activePath) return;
    const record = workspaces.resolveWorkspaceForPath(activePath);
    if (!record) return;
    if (record.last_active_path !== activePath) {
      workspaces.updateWorkspace(record.workspace_id, {
        last_active_path: activePath,
        last_used_at: Date.now(),
      });
    }
  }, [
    active_project_tab,
    workspaces.resolveWorkspaceForPath,
    workspaces.updateWorkspace,
    workspaces.records,
  ]);

  useLayoutEffect(() => {
    const currentSelectionKey =
      workspaces.selection.kind === "workspace"
        ? `workspace:${workspaces.selection.workspace_id}`
        : workspaces.selection.kind;
    const selectionChanged =
      previousWorkspaceSelectionRef.current !== currentSelectionKey;
    previousWorkspaceSelectionRef.current = currentSelectionKey;

    if (selectionChanged) {
      workspaceRestorePendingRef.current =
        workspaces.selection.kind === "workspace";
      workspaceRestoreStableMatchesRef.current = 0;
    }

    if (!actions) return;
    const orderedPaths: string[] =
      open_files_order?.toJS?.() ?? open_files_order ?? [];
    if (workspaces.selection.kind !== "workspace") {
      workspaceRestorePendingRef.current = false;
      workspaceRestoreStableMatchesRef.current = 0;
      if (workspaces.selection.kind === "unscoped") {
        const resolution = resolveHiddenActiveTabForSelection({
          activeProjectTab: active_project_tab,
          orderedPaths,
          matchesPath: workspaces.matchesPath,
        });
        if (resolution.kind === "activate-path") {
          actions.set_active_tab(path_to_tab(resolution.path), {
            change_history: false,
          });
          return;
        }
        if (resolution.kind === "show-files") {
          actions.set_active_tab("files", { change_history: false });
          return;
        }
      }
      return;
    }
    const current = workspaces.current;
    if (!current) return;
    const previousActivePath = previousActivePathRef.current;
    const previousOpenPaths = previousOpenFilesOrderRef.current;
    const orderStable =
      orderedPaths.length === previousOpenPaths.length &&
      orderedPaths.every((path, index) => path === previousOpenPaths[index]);
    const confirmWorkspaceRestore = () => {
      if (!workspaceRestorePendingRef.current) return true;
      if (!orderStable) {
        workspaceRestoreStableMatchesRef.current = 0;
        return false;
      }
      workspaceRestoreStableMatchesRef.current += 1;
      if (workspaceRestoreStableMatchesRef.current < 2) {
        return false;
      }
      workspaceRestorePendingRef.current = false;
      workspaceRestoreStableMatchesRef.current = 0;
      return true;
    };
    const getFallbackPath = () => {
      if (
        current.last_active_path &&
        orderedPaths.includes(current.last_active_path) &&
        workspaces.matchesPath(current.last_active_path)
      ) {
        return current.last_active_path;
      }
      return orderedPaths.find((path) => {
        return (
          workspaces.resolveWorkspaceForPath(path)?.workspace_id ===
          current.workspace_id
        );
      });
    };
    const openFallbackPath = (path: string) => {
      workspaceRestoreStableMatchesRef.current = 0;
      if (orderedPaths.includes(path)) {
        actions.set_active_tab(path_to_tab(path), { change_history: false });
      } else {
        void actions.open_file({
          path,
          foreground: true,
          foreground_project: false,
          change_history: false,
        });
      }
    };

    if (active_project_tab && !active_project_tab.startsWith("editor-")) {
      if (active_project_tab !== "files") return;
      if (current_path_abs === "/") {
        void actions.open_directory(current.root_path, false, true);
        return;
      }
      if (
        current_path_abs &&
        pathMatchesRoot(current_path_abs, current.root_path) &&
        !selectionChanged
      ) {
        if (!confirmWorkspaceRestore()) {
          return;
        }
        return;
      }
      if (workspaceRestorePendingRef.current && getFallbackPath()) {
        openFallbackPath(getFallbackPath()!);
        return;
      }
      if (current_path_abs && !selectionChanged) {
        if (workspaces.loading) return;
        const nextSelection = selectionForPath(
          workspaces.records,
          current_path_abs,
        );
        workspaces.setSelection(nextSelection);
        return;
      }
      void actions.open_directory(current.root_path, false, true);
      return;
    }
    const activePath = tab_to_path(active_project_tab ?? "");
    const activePathIsOpen = activePath
      ? orderedPaths.includes(activePath)
      : false;
    const previousActivePathClosed =
      !!previousActivePath &&
      previousActivePath !== activePath &&
      previousOpenPaths.includes(previousActivePath) &&
      !orderedPaths.includes(previousActivePath);
    if (activePath && workspaces.matchesPath(activePath) && activePathIsOpen) {
      if (!confirmWorkspaceRestore()) {
        return;
      }
      return;
    }
    if (activePath && workspaces.matchesPath(activePath) && !activePathIsOpen) {
      openFallbackPath(activePath);
      return;
    }
    const fallbackPath = getFallbackPath();
    if (workspaceRestorePendingRef.current && fallbackPath) {
      openFallbackPath(fallbackPath);
      return;
    }
    if (
      activePath &&
      activePathIsOpen &&
      !selectionChanged &&
      !previousActivePathClosed
    ) {
      if (workspaces.loading) return;
      const nextSelection = selectionForPath(workspaces.records, activePath);
      workspaces.setSelection(nextSelection);
      return;
    }

    if (fallbackPath) {
      openFallbackPath(fallbackPath);
      return;
    }

    void actions.open_directory(current.root_path, false, true);
  }, [
    actions,
    active_project_tab,
    current_path_abs,
    open_files_order,
    workspaces.current,
    workspaces.loading,
    workspaces.matchesPath,
    workspaces.records,
    workspaces.selection,
  ]);

  useEffect(() => {
    previousActivePathRef.current = tab_to_path(active_project_tab ?? "") ?? "";
    previousOpenFilesOrderRef.current =
      open_files_order?.toJS?.() ?? open_files_order ?? [];
  }, [active_project_tab, open_files_order]);

  const registerUserFilesystemChangeHandler = useCallback(
    (handler: (() => void) | null | undefined) =>
      registerProjectFilesystemChangeHandler({ project_id, handler }),
    [project_id],
  );

  const notifyUserFilesystemChange = useCallback(() => {
    notifyProjectFilesystemChange(project_id);
  }, [project_id]);

  return {
    actions,
    active_project_tab,
    contentSize,
    enabledLLMs,
    flipTabs,
    group,
    hasInternet,
    is_active,
    isRunning,
    mainWidthPx,
    manageStarredFiles,
    onCoCalcCom,
    onCoCalcDocker,
    project_id,
    project,
    notifyUserFilesystemChange,
    registerUserFilesystemChangeHandler,
    setContentSize,
    status,
    workspaces,
  };
}
