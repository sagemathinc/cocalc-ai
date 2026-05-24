/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getDocsAction,
  isDocsActionId,
  listDocsActions,
  type DocsActionId,
  type DocsActionSummary,
} from "@cocalc/docs";
import { default_filename } from "@cocalc/frontend/account";
import { redux } from "@cocalc/frontend/app-framework";
import { separate_file_extension } from "@cocalc/util/misc";

export const PROJECT_SECRETS_DOCS_ACTION_EVENT =
  "cocalc:docs-action:project-secrets";
export const RUNTIME_IMAGE_DOCS_ACTION_EVENT =
  "cocalc:docs-action:runtime-image";

export interface ProjectSecretsDocsActionDetail {
  projectId: string;
}

export interface RuntimeImageDocsActionDetail {
  projectId: string;
}

export type DocsActionRevealResult = {
  action_id: DocsActionId;
  opened: true;
  path?: string;
  panel?: string;
  project_id: string;
  tab?: string;
};

export type DocsActionAvailability = DocsActionSummary & {
  available: boolean;
  implemented: boolean;
  reason?: string;
};

type DocsAppAction = {
  id: DocsActionId;
  isAvailable?: (context: { projectId: string }) => string | true;
  run: (context: {
    projectId: string;
  }) => DocsActionRevealResult | Promise<DocsActionRevealResult>;
};

type ProjectActionSubset = {
  construct_absolute_path?: (
    name: string,
    current_path?: string,
    ext?: string,
  ) => string;
  createFile?: (opts: {
    current_path?: string;
    ext?: string;
    name: string;
    switch_over?: boolean;
  }) => Promise<void>;
  get_store?: () =>
    | {
        get?: (key: string) => any;
      }
    | undefined;
  open_file?: (opts: { path: string; foreground?: boolean }) => void;
  set_active_tab?: (
    key: string,
    opts?: { change_history?: boolean; noFocus?: boolean },
  ) => void;
  setFlyoutExpanded?: (
    name: "settings",
    state: boolean,
    save?: boolean,
  ) => void;
};

function dispatchProjectSecretsEvent(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProjectSecretsDocsActionDetail>(
      PROJECT_SECRETS_DOCS_ACTION_EVENT,
      {
        detail: { projectId },
      },
    ),
  );
}

function dispatchRuntimeImageEvent(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RuntimeImageDocsActionDetail>(
      RUNTIME_IMAGE_DOCS_ACTION_EVENT,
      {
        detail: { projectId },
      },
    ),
  );
}

function validateProjectId(projectId: string): string | true {
  return projectId.trim() ? true : "No project is selected.";
}

function projectActions(projectId: string): ProjectActionSubset | undefined {
  return redux.getProjectActions(projectId) as ProjectActionSubset | undefined;
}

function selectProject(projectId: string): void {
  const pageActions = redux.getActions("page") as
    | {
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.(projectId, false);
}

function storeSettingsFlyoutState(
  projectId: string,
  panel = "environment",
): void {
  if (typeof window === "undefined") return;
  const key = `${projectId}::flyout`;
  let current: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed;
      }
    }
  } catch {
    current = {};
  }
  current.expanded = "settings";
  current.settings = [panel];
  window.localStorage.setItem(key, JSON.stringify(current));
}

function openSettingsEnvironment(projectId: string): void {
  storeSettingsFlyoutState(projectId);
  selectProject(projectId);
  const actions = projectActions(projectId);
  actions?.set_active_tab?.("settings", {
    change_history: false,
    noFocus: true,
  });
  actions?.setFlyoutExpanded?.("settings", true);
}

function revealProjectSecrets(projectId: string): DocsActionRevealResult {
  openSettingsEnvironment(projectId);

  // The settings panel may mount after the action switches tabs. Dispatch a few
  // times so the component can catch the action without needing global UI state.
  dispatchProjectSecretsEvent(projectId);
  setTimeout(() => dispatchProjectSecretsEvent(projectId), 100);
  setTimeout(() => dispatchProjectSecretsEvent(projectId), 500);

  return {
    action_id: "settings.environment.secrets",
    opened: true,
    panel: "project-secrets",
    project_id: projectId,
    tab: "settings",
  };
}

function revealRuntimeImage(projectId: string): DocsActionRevealResult {
  openSettingsEnvironment(projectId);

  dispatchRuntimeImageEvent(projectId);
  setTimeout(() => dispatchRuntimeImageEvent(projectId), 100);
  setTimeout(() => dispatchRuntimeImageEvent(projectId), 500);

  return {
    action_id: "settings.runtime.rootfs",
    opened: true,
    panel: "runtime-image",
    project_id: projectId,
    tab: "settings",
  };
}

async function createDefaultProjectFile({
  actionId,
  ext,
  projectId,
}: {
  actionId: DocsActionId;
  ext: "ipynb" | "term";
  projectId: string;
}): Promise<DocsActionRevealResult> {
  selectProject(projectId);
  const actions = projectActions(projectId);
  if (!actions?.createFile) {
    throw Error("Project actions are not ready.");
  }
  const currentPath = actions.get_store?.()?.get?.("current_path_abs") ?? "/";
  const filename = default_filename(ext, projectId);
  const { name, ext: filenameExt } = separate_file_extension(filename);
  const fileExt = filenameExt || ext;
  const path =
    actions.construct_absolute_path?.(name, currentPath, fileExt) ??
    `${currentPath.replace(/\/+$/, "")}/${name}.${fileExt}`;

  await actions.createFile({
    current_path: currentPath,
    ext: fileExt,
    name,
    switch_over: true,
  });

  return {
    action_id: actionId,
    opened: true,
    path,
    project_id: projectId,
  };
}

const DOCS_APP_ACTIONS: Record<string, DocsAppAction> = {
  "settings.environment.secrets": {
    id: "settings.environment.secrets",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealProjectSecrets(projectId),
  },
  "project.terminal.open": {
    id: "project.terminal.open",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) =>
      createDefaultProjectFile({
        actionId: "project.terminal.open",
        ext: "term",
        projectId,
      }),
  },
  "project.jupyter.create": {
    id: "project.jupyter.create",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) =>
      createDefaultProjectFile({
        actionId: "project.jupyter.create",
        ext: "ipynb",
        projectId,
      }),
  },
  "settings.runtime.rootfs": {
    id: "settings.runtime.rootfs",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealRuntimeImage(projectId),
  },
};

export function getDocsAppAction(actionId: string): DocsAppAction | undefined {
  return DOCS_APP_ACTIONS[actionId];
}

export function listDocsAppActions({
  projectId,
}: {
  projectId: string;
}): DocsActionAvailability[] {
  return listDocsActions().map((action) => {
    const appAction = getDocsAppAction(action.id);
    const available = appAction?.isAvailable?.({ projectId }) ?? !!appAction;
    return {
      ...action,
      available: available === true,
      implemented: !!appAction,
      ...(typeof available === "string" ? { reason: available } : {}),
    };
  });
}

export function revealDocsAction({
  actionId,
  projectId,
}: {
  actionId: string;
  projectId: string;
}): DocsActionRevealResult | Promise<DocsActionRevealResult> {
  if (!isDocsActionId(actionId)) {
    throw Error(`unknown docs action '${actionId}'`);
  }
  const action = getDocsAction(actionId);
  if (!action?.executable) {
    throw Error(`docs action '${actionId}' is not executable yet`);
  }
  const appAction = getDocsAppAction(actionId);
  if (!appAction) {
    throw Error(`docs action '${actionId}' has no browser implementation`);
  }
  const available = appAction.isAvailable?.({ projectId }) ?? true;
  if (available !== true) {
    throw Error(`docs action '${actionId}' is not available: ${available}`);
  }
  return appAction.run({ projectId });
}
