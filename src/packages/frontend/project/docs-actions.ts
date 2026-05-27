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
import {
  getAdminUrlPath,
  type AdminRoute,
  type AdminSection,
} from "@cocalc/frontend/admin/routing";
import { redux } from "@cocalc/frontend/app-framework";
import { set_url_with_search } from "@cocalc/frontend/history";
import {
  history_path,
  separate_file_extension,
  tab_to_path,
} from "@cocalc/util/misc";
import { openHostDrawer } from "@cocalc/frontend/hosts/open-host-drawer";

export const PROJECT_SECRETS_DOCS_ACTION_EVENT =
  "cocalc:docs-action:project-secrets";
export const RUNTIME_IMAGE_DOCS_ACTION_EVENT =
  "cocalc:docs-action:runtime-image";
export const PROJECT_PEOPLE_DOCS_ACTION_EVENT =
  "cocalc:docs-action:project-people";

export type SettingsDocsActionSurface = "flyout" | "project";

export interface ProjectSecretsDocsActionDetail {
  projectId: string;
  surface?: SettingsDocsActionSurface;
}

export interface RuntimeImageDocsActionDetail {
  projectId: string;
  surface?: SettingsDocsActionSurface;
}

export interface ProjectPeopleDocsActionDetail {
  projectId: string;
}

export type DocsActionRevealResult = {
  action_id: DocsActionId;
  drawer_tab?: string;
  host_id?: string;
  opened: true;
  path?: string;
  panel?: string;
  project_id: string;
  source_path?: string;
  tab?: string;
};

export type DocsActionParameters = Record<string, string | undefined>;

export type DocsActionAvailability = DocsActionSummary & {
  available: boolean;
  implemented: boolean;
  reason?: string;
};

type DocsAppAction = {
  id: DocsActionId;
  isAvailable?: (context: {
    includeAdmin?: boolean;
    projectId: string;
  }) => string | true;
  run: (context: {
    includeAdmin?: boolean;
    parameters?: DocsActionParameters;
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
  get_filenames_in_current_dir?: () => Record<string, unknown> | null;
  open_file?: (opts: { path: string; foreground?: boolean }) => void;
  set_active_tab?: (
    key: string,
    opts?: { change_history?: boolean; noFocus?: boolean },
  ) => void;
  setFlyoutExpanded?: (
    name: "agents" | "settings",
    state: boolean,
    save?: boolean,
  ) => void;
};

function dispatchProjectSecretsEvent(
  projectId: string,
  surface: SettingsDocsActionSurface = "flyout",
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProjectSecretsDocsActionDetail>(
      PROJECT_SECRETS_DOCS_ACTION_EVENT,
      {
        detail: { projectId, surface },
      },
    ),
  );
}

function dispatchRuntimeImageEvent(
  projectId: string,
  surface: SettingsDocsActionSurface = "flyout",
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RuntimeImageDocsActionDetail>(
      RUNTIME_IMAGE_DOCS_ACTION_EVENT,
      {
        detail: { projectId, surface },
      },
    ),
  );
}

function dispatchProjectPeopleEvent(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProjectPeopleDocsActionDetail>(
      PROJECT_PEOPLE_DOCS_ACTION_EVENT,
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

function accountIsAdmin(): boolean {
  return !!redux.getStore("account")?.get("is_admin");
}

function validateAdmin(): string | true {
  return accountIsAdmin() ? true : "You must be a site admin.";
}

function selectAdmin(route: AdminRoute, search = ""): void {
  const pageActions = redux.getActions("page") as
    | {
        setState?: (state: { admin_route?: AdminRoute }) => void;
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.("admin", false);
  pageActions?.setState?.({ admin_route: route });
  if (typeof window !== "undefined") {
    set_url_with_search(getAdminUrlPath(route), search);
  }
}

function revealHostsPage({
  actionId,
  hostId,
  projectId,
  tab,
}: {
  actionId: DocsActionId;
  hostId?: string;
  projectId: string;
  tab?: string;
}): DocsActionRevealResult {
  const normalizedHostId = `${hostId ?? ""}`.trim();
  const normalizedTab = `${tab ?? ""}`.trim();
  if (normalizedHostId) {
    openHostDrawer({
      hostId: normalizedHostId,
      tab: normalizedTab || undefined,
    });
    return {
      action_id: actionId,
      drawer_tab: normalizedTab || undefined,
      host_id: normalizedHostId,
      opened: true,
      project_id: projectId,
      tab: "hosts",
    };
  }
  const pageActions = redux.getActions("page") as
    | {
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.("hosts", false);
  if (typeof window !== "undefined") {
    set_url_with_search("/hosts", "");
  }
  return {
    action_id: actionId,
    opened: true,
    project_id: projectId,
    tab: "hosts",
  };
}

function revealAdminSection({
  actionId,
  projectId,
  section,
}: {
  actionId: DocsActionId;
  projectId: string;
  section: AdminSection;
}): DocsActionRevealResult {
  const route: AdminRoute = { kind: "index", section };
  selectAdmin(route);
  return {
    action_id: actionId,
    opened: true,
    panel: section,
    project_id: projectId,
    tab: "admin",
  };
}

function revealAdminNews({
  actionId,
  projectId,
  route,
  search = "",
}: {
  actionId: DocsActionId;
  projectId: string;
  route: AdminRoute;
  search?: string;
}): DocsActionRevealResult {
  selectAdmin(route, search);
  return {
    action_id: actionId,
    opened: true,
    panel: route.kind,
    project_id: projectId,
    tab: "admin",
  };
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
  openSettingsPanel(projectId, "environment");
}

function openSettingsPanel(projectId: string, panel: string): void {
  storeSettingsFlyoutState(projectId);
  storeSettingsFlyoutState(projectId, panel);
  selectProject(projectId);
  const actions = projectActions(projectId);
  actions?.set_active_tab?.("settings", {
    change_history: false,
    noFocus: true,
  });
  actions?.setFlyoutExpanded?.("settings", true);
}

function revealProjectPeople(projectId: string): DocsActionRevealResult {
  openSettingsPanel(projectId, "people");
  if (typeof window !== "undefined") {
    window.location.hash = "people";
  }
  dispatchProjectPeopleEvent(projectId);
  setTimeout(() => dispatchProjectPeopleEvent(projectId), 100);
  setTimeout(() => dispatchProjectPeopleEvent(projectId), 500);
  return {
    action_id: "settings.people.collaborators",
    opened: true,
    panel: "people",
    project_id: projectId,
    tab: "settings",
  };
}

function getActiveOrRecentProjectFile(projectId: string): string | undefined {
  const store = projectActions(projectId)?.get_store?.();
  const activeTab = `${store?.get?.("active_project_tab") ?? ""}`;
  const activePath = tab_to_path(activeTab);
  if (activePath) return activePath;

  const openFilesOrder = store?.get?.("open_files_order");
  const openFiles =
    typeof openFilesOrder?.toJS === "function"
      ? openFilesOrder.toJS()
      : typeof openFilesOrder?.toArray === "function"
        ? openFilesOrder.toArray()
        : Array.isArray(openFilesOrder)
          ? openFilesOrder
          : [];
  for (let i = openFiles.length - 1; i >= 0; i -= 1) {
    const path = `${openFiles[i] ?? ""}`.trim();
    if (path && !path.endsWith(".time-travel")) return path;
  }
}

async function revealTimeTravel(
  projectId: string,
): Promise<DocsActionRevealResult> {
  selectProject(projectId);
  const actions = projectActions(projectId);
  let sourcePath = getActiveOrRecentProjectFile(projectId);
  if (!sourcePath) {
    const created = await createDefaultProjectFile({
      actionId: "file.timetravel.open",
      ext: "txt",
      projectId,
    });
    sourcePath = created.path;
  }
  if (!sourcePath) {
    throw Error("Could not determine a file for TimeTravel.");
  }
  const path = history_path(sourcePath);
  actions?.open_file?.({ path, foreground: true });
  return {
    action_id: "file.timetravel.open",
    opened: true,
    path,
    project_id: projectId,
    source_path: sourcePath,
  };
}

function revealCodex(projectId: string): DocsActionRevealResult {
  selectProject(projectId);
  const actions = projectActions(projectId);
  actions?.set_active_tab?.("agents", { change_history: true });
  actions?.setFlyoutExpanded?.("agents", true);
  return {
    action_id: "project.codex.open",
    opened: true,
    project_id: projectId,
    tab: "agents",
  };
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

function defaultDocsActionFilename(
  ext: "ipynb" | "term" | "txt",
  avoid?: Record<string, unknown> | null,
): string {
  const basename =
    ext === "ipynb"
      ? "notebook"
      : ext === "term"
        ? "terminal"
        : "timetravel-source";
  for (let i = 1; i < 1000; i += 1) {
    const suffix = i === 1 ? "" : `-${i}`;
    const filename = `${basename}${suffix}.${ext}`;
    if (!avoid?.[filename]) return filename;
  }
  return `${basename}-${Date.now()}.${ext}`;
}

async function createDefaultProjectFile({
  actionId,
  ext,
  projectId,
}: {
  actionId: DocsActionId;
  ext: "ipynb" | "term" | "txt";
  projectId: string;
}): Promise<DocsActionRevealResult> {
  selectProject(projectId);
  const actions = projectActions(projectId);
  if (!actions?.createFile) {
    throw Error("Project actions are not ready.");
  }
  const currentPath = actions.get_store?.()?.get?.("current_path_abs") ?? "/";
  const filename = defaultDocsActionFilename(
    ext,
    actions.get_filenames_in_current_dir?.(),
  );
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
  "admin.news.open": {
    id: "admin.news.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminNews({
        actionId: "admin.news.open",
        projectId,
        route: { kind: "news-list" },
      }),
  },
  "admin.news.create-system": {
    id: "admin.news.create-system",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminNews({
        actionId: "admin.news.create-system",
        projectId,
        route: { kind: "news-editor", id: "new" },
        search: "?channel=system",
      }),
  },
  "admin.bay-ops.open": {
    id: "admin.bay-ops.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.bay-ops.open",
        projectId,
        section: "bay-ops",
      }),
  },
  "admin.membership-tiers.open": {
    id: "admin.membership-tiers.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.membership-tiers.open",
        projectId,
        section: "membership-tiers",
      }),
  },
  "admin.managed-egress.open": {
    id: "admin.managed-egress.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.managed-egress.open",
        projectId,
        section: "managed-egress",
      }),
  },
  "admin.project-backup-shards.open": {
    id: "admin.project-backup-shards.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.project-backup-shards.open",
        projectId,
        section: "project-backup-shards",
      }),
  },
  "admin.registration-tokens.open": {
    id: "admin.registration-tokens.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.registration-tokens.open",
        projectId,
        section: "registration-tokens",
      }),
  },
  "admin.rootfs.open": {
    id: "admin.rootfs.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.rootfs.open",
        projectId,
        section: "rootfs",
      }),
  },
  "admin.site-settings.open": {
    id: "admin.site-settings.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.site-settings.open",
        projectId,
        section: "site-settings",
      }),
  },
  "admin.software-licenses.open": {
    id: "admin.software-licenses.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.software-licenses.open",
        projectId,
        section: "software-licenses",
      }),
  },
  "admin.sso.open": {
    id: "admin.sso.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.sso.open",
        projectId,
        section: "sso",
      }),
  },
  "admin.users.open": {
    id: "admin.users.open",
    isAvailable: validateAdmin,
    run: ({ projectId }) =>
      revealAdminSection({
        actionId: "admin.users.open",
        projectId,
        section: "user-search",
      }),
  },
  "hosts.open": {
    id: "hosts.open",
    run: ({ projectId }) =>
      revealHostsPage({ actionId: "hosts.open", projectId }),
  },
  "hosts.access.open": {
    id: "hosts.access.open",
    run: ({ parameters, projectId }) =>
      revealHostsPage({
        actionId: "hosts.access.open",
        hostId: parameters?.hostId,
        projectId,
        tab: "access",
      }),
  },
  "hosts.move.open": {
    id: "hosts.move.open",
    run: ({ projectId }) =>
      revealHostsPage({ actionId: "hosts.move.open", projectId }),
  },
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
  "settings.people.collaborators": {
    id: "settings.people.collaborators",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealProjectPeople(projectId),
  },
  "file.timetravel.open": {
    id: "file.timetravel.open",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealTimeTravel(projectId),
  },
  "project.codex.open": {
    id: "project.codex.open",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealCodex(projectId),
  },
};

export function getDocsAppAction(actionId: string): DocsAppAction | undefined {
  return DOCS_APP_ACTIONS[actionId];
}

export function listDocsAppActions({
  includeAdmin = accountIsAdmin(),
  projectId,
}: {
  includeAdmin?: boolean;
  projectId: string;
}): DocsActionAvailability[] {
  return listDocsActions({ includeAdmin }).map((action) => {
    const appAction = getDocsAppAction(action.id);
    const available =
      appAction?.isAvailable?.({ includeAdmin, projectId }) ?? !!appAction;
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
  includeAdmin = accountIsAdmin(),
  parameters,
  projectId,
}: {
  actionId: string;
  includeAdmin?: boolean;
  parameters?: DocsActionParameters;
  projectId: string;
}): DocsActionRevealResult | Promise<DocsActionRevealResult> {
  if (!isDocsActionId(actionId)) {
    throw Error(`unknown docs action '${actionId}'`);
  }
  const action = getDocsAction(actionId, { includeAdmin });
  if (!action) {
    throw Error(`docs action '${actionId}' is not available`);
  }
  if (!action.executable) {
    throw Error(`docs action '${actionId}' is not executable yet`);
  }
  const appAction = getDocsAppAction(actionId);
  if (!appAction) {
    throw Error(`docs action '${actionId}' has no browser implementation`);
  }
  const available =
    appAction.isAvailable?.({ includeAdmin, projectId }) ?? true;
  if (available !== true) {
    throw Error(`docs action '${actionId}' is not available: ${available}`);
  }
  return appAction.run({ parameters, projectId });
}
