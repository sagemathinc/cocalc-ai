/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Context,
  createContext,
  useContext,
  useEffect,
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
import {
  pathMatchesRoot,
  selectionForPath,
  useProjectWorkspaces,
} from "./workspaces/state";
import type { ProjectWorkspaceState } from "./workspaces/types";
import { path_to_tab, tab_to_path } from "@cocalc/util/misc";

export interface ProjectContextState {
  actions?: ProjectActions;
  active_project_tab?: string;
  compute_image: string | undefined;
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
  setContentSize: (size: { width: number; height: number }) => void;
  status: ProjectStatus;
  workspaces: ProjectWorkspaceState;
}

export const emptyProjectContext = {
  actions: undefined,
  active_project_tab: undefined,
  compute_image: undefined,
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
  const { project, group, compute_image } = useProject(project_id);
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
    useMemo(() => effectiveStatus === "running", [effectiveStatus]) ||
    lite;
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

  useEffect(() => {
    const activePath = tab_to_path(active_project_tab ?? "");
    if (!activePath) return;
    const record = workspaces.resolveWorkspaceForPath(activePath);
    if (!record) return;
    if (record.last_active_path === activePath) return;
    workspaces.updateWorkspace(record.workspace_id, {
      last_active_path: activePath,
    });
  }, [
    active_project_tab,
    workspaces.resolveWorkspaceForPath,
    workspaces.updateWorkspace,
    workspaces.records,
  ]);

  useEffect(() => {
    const currentSelectionKey =
      workspaces.selection.kind === "workspace"
        ? `workspace:${workspaces.selection.workspace_id}`
        : workspaces.selection.kind;
    const selectionChanged =
      previousWorkspaceSelectionRef.current !== currentSelectionKey;
    previousWorkspaceSelectionRef.current = currentSelectionKey;

    if (!actions) return;
    if (workspaces.selection.kind !== "workspace") return;
    if (active_project_tab && !active_project_tab.startsWith("editor-")) {
      if (active_project_tab !== "files") return;
      const current = workspaces.current;
      if (!current) return;
      if (current_path_abs && pathMatchesRoot(current_path_abs, current.root_path)) {
        return;
      }
      if (current_path_abs && !selectionChanged) {
        workspaces.setSelection(
          selectionForPath(workspaces.records, current_path_abs),
        );
        return;
      }
      void actions.open_directory(current.root_path, false, true);
      return;
    }
    const activePath = tab_to_path(active_project_tab ?? "");
    if (activePath && workspaces.matchesPath(activePath)) return;
    if (activePath && !selectionChanged) {
      workspaces.setSelection(selectionForPath(workspaces.records, activePath));
      return;
    }

    const current = workspaces.current;
    if (!current) return;
    const orderedPaths: string[] = open_files_order?.toJS?.() ?? open_files_order ?? [];
    const fallbackPath =
      (current.last_active_path &&
      orderedPaths.includes(current.last_active_path) &&
      workspaces.matchesPath(current.last_active_path)
        ? current.last_active_path
        : null) ??
      orderedPaths.find((path) => {
        return workspaces.resolveWorkspaceForPath(path)?.workspace_id === current.workspace_id;
      });

    if (fallbackPath) {
      actions.set_active_tab(path_to_tab(fallbackPath), { change_history: false });
      return;
    }

    void actions.open_directory(current.root_path, false, true);
  }, [
    actions,
    active_project_tab,
    current_path_abs,
    open_files_order,
    workspaces.current,
    workspaces.matchesPath,
    workspaces.records,
    workspaces.selection,
  ]);

  return {
    actions,
    active_project_tab,
    compute_image,
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
    setContentSize,
    status,
    workspaces,
  };
}
