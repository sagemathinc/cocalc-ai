/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Implement the open_file actions for opening one single file in a project.

import { alert_message } from "@cocalc/frontend/alerts";
import { redux } from "@cocalc/frontend/app-framework";
import { local_storage } from "@cocalc/frontend/editor-local-storage";
import Fragment, { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import { remove } from "@cocalc/frontend/project-file";
import { ProjectActions } from "@cocalc/frontend/project_actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { relative } from "path";
import {
  defaults,
  filename_extension,
  path_split,
  path_to_tab,
  required,
  uuid,
} from "@cocalc/util/misc";
import { until } from "@cocalc/util/async-utils";
import { isChatExtension } from "@cocalc/frontend/chat/paths";
import { getRuntimeWorkspaceRecords } from "@cocalc/frontend/project/workspaces/records-runtime";
import { workingDirectoryForProjectFile } from "@cocalc/frontend/project/workspaces/chat-working-directory";
import {
  dispatchWorkspaceSelectionEvent,
  loadSessionSelection,
  persistSessionSelection,
} from "@cocalc/frontend/project/workspaces/selection-runtime";
import { selectionForPathFollowThrough } from "@cocalc/frontend/project/workspaces/state";
import type { WorkspaceSelection } from "@cocalc/frontend/project/workspaces/types";
import { getProjectLifecycleView } from "@cocalc/frontend/projects/host-operational";
import { normalize } from "./utils";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { canonicalSyncPath, toAbsoluteProjectPath } from "./sync-path";
import {
  getProjectUserRole,
  isViewerProjectRole,
} from "@cocalc/frontend/project/realtime-access";
import {
  elapsedUxMs,
  recordUxLatencyEvent,
  startUxTimer,
} from "@cocalc/frontend/monitoring/ux-latency";

// if true, PRELOAD_BACKGROUND_TABS makes it so all tabs have their file editing
// preloaded, even background tabs.  This can make the UI much more responsive,
// since after refreshing your browser or opening a project that had tabs open,
// all files are ready to edit instantly.  It uses more browser memory (of course),
// and increases server load.  Most users have very few files open at once,
// so this is probably a major win for power users and has little impact on load.
// Do NOT set this to true until we have a very good way of dealing with load
// problems, e.g., a way to easily load with no files open.  Otherwise, you can get
// stuck due a file taking too long to load, etc.
const PRELOAD_BACKGROUND_TABS = false;

export interface OpenFileOpts {
  path: string;
  ext?: string; // if given, use editor for this extension instead of whatever extension path has.
  line?: number; // mainly backward compat for now
  fragmentId?: FragmentId; // optional URI fragment identifier that describes position in this document to jump to when we actually open it, which could be long in the future, e.g., due to shift+click to open a background tab.  Inspiration from https://en.wikipedia.org/wiki/URI_fragment
  foreground?: boolean;
  foreground_project?: boolean;
  // if false, return once the loading tab exists and continue the remaining
  // sync identity / project availability work in the background.
  wait_for_ready?: boolean;
  chat?: boolean;
  chat_width?: number;
  ignore_kiosk?: boolean;
  new_browser_window?: boolean;
  change_history?: boolean;
  // opened via an explicit click
  explicit?: boolean;
  workspaceSelection?: WorkspaceSelection;
}

export function findOpenDisplayPathForSyncPath(
  actions: ProjectActions,
  syncPath: string,
  excludeDisplayPath?: string,
): string | undefined {
  const store = actions.get_store();
  const openFiles = store?.get("open_files");
  if (openFiles == null) {
    return undefined;
  }
  let found: string | undefined;
  openFiles.forEach((_obj, displayPath) => {
    if (found != null || displayPath === excludeDisplayPath) {
      return;
    }
    const otherSyncPath = openFiles.getIn([displayPath, "sync_path"]);
    if (typeof otherSyncPath === "string") {
      if (otherSyncPath === syncPath) {
        found = displayPath;
      }
      return;
    }
    // Terminal tabs can be restored or still opening before their sync_path is
    // populated.  Avoid opening a second hidden terminal identity tab for a
    // mention target that resolves to the same terminal session.
    if (canonicalPath(`${displayPath}`) === syncPath) {
      found = displayPath;
    }
  });
  return found;
}

type SyncIdentityFs = {
  canonicalSyncIdentityPath?: (path: string) => Promise<string>;
};

const SYNC_IDENTITY_RETRY_START_MS = 150;
const SYNC_IDENTITY_RETRY_MAX_MS = 1500;
const PROJECT_OPEN_RETRY_START_MS = 500;
const PROJECT_OPEN_RETRY_MAX_MS = 5000;

export function isTransientSyncIdentityResolutionError(err: unknown): boolean {
  const message = `${err}`.trim().toLowerCase();
  return (
    message === "closed" ||
    message.endsWith(": closed") ||
    message.includes('not emitted before "closed"') ||
    message.includes("file server not initialized") ||
    message.includes("not initialized") ||
    message.includes("socket has been disconnected") ||
    message.includes("disconnected") ||
    message.includes("connection closed") ||
    message.includes("connection refused") ||
    message.includes("not connected") ||
    message.includes("no responders") ||
    message.includes("unable to route") ||
    message.includes("project-host") ||
    message.includes("project host") ||
    message.includes("code=408") ||
    message.includes("timeout") ||
    message.includes("waiting for")
  );
}

export function isCancelledSyncIdentityResolutionError(err: unknown): boolean {
  return `${err}`.includes("canonical sync identity open was cancelled");
}

export function isTransientProjectOpenError(err: unknown): boolean {
  const message = `${err}`.trim().toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("waiting for") ||
    message.includes("project host id unavailable") ||
    message.includes("project is not running") ||
    message.includes("project not running") ||
    message.includes("unable to route") ||
    message.includes("project-host") ||
    message.includes("project host")
  );
}

export function isCancelledProjectOpenRetryError(err: unknown): boolean {
  return `${err}`.includes("project open retry was cancelled");
}

export async function ensureProjectIsOpenWithRetry(
  actions: Pick<ProjectActions, "ensureProjectIsOpen">,
  {
    foreground_project = true,
    isOpen = () => true,
  }: {
    foreground_project?: boolean;
    isOpen?: () => boolean;
  } = {},
): Promise<void> {
  await until(
    async () => {
      if (!isOpen()) {
        throw new Error("project open retry was cancelled");
      }
      try {
        await actions.ensureProjectIsOpen(foreground_project);
        return true;
      } catch (err) {
        if (!isTransientProjectOpenError(err)) {
          throw err;
        }
        return false;
      }
    },
    {
      start: PROJECT_OPEN_RETRY_START_MS,
      max: PROJECT_OPEN_RETRY_MAX_MS,
    },
  );
}

function shouldSuppressArchivedOpenError(project_id: string): boolean {
  const project = redux
    .getStore("projects")
    ?.get("project_map")
    ?.get(project_id);
  return getProjectLifecycleView({
    projectState: project?.getIn(["state", "state"]),
    lastBackup: project?.get("last_backup"),
  }).isArchivedLike;
}

export function applyWorkspaceSelectionForForegroundOpen(
  project_id: string,
  path: string,
  explicitSelection?: WorkspaceSelection,
): void {
  const records = getRuntimeWorkspaceRecords(project_id);
  if (records.length === 0) return;
  const currentSelection = loadSessionSelection(project_id);
  const nextSelection =
    explicitSelection ??
    selectionForPathFollowThrough(currentSelection, records, path);
  const sameSelection =
    currentSelection.kind === nextSelection.kind &&
    (currentSelection.kind !== "workspace" ||
      (nextSelection.kind === "workspace" &&
        currentSelection.workspace_id === nextSelection.workspace_id));
  if (sameSelection) {
    return;
  }
  persistSessionSelection(project_id, nextSelection);
  dispatchWorkspaceSelectionEvent(project_id, nextSelection);
}

export async function resolveSyncPath(
  fs: SyncIdentityFs,
  displayPath: string,
  projectHome: string,
): Promise<string> {
  if (typeof fs.canonicalSyncIdentityPath !== "function") {
    throw new Error(
      "backend does not provide canonicalSyncIdentityPath; refusing to open file unsafely",
    );
  }
  // In launchpad/sandbox mode, this preserves the user-facing canonical sync
  // identity instead of leaking container-internal realpaths.
  const syncPath = await fs.canonicalSyncIdentityPath(displayPath);
  if (typeof syncPath !== "string" || syncPath.length === 0) {
    throw new Error(
      `backend returned invalid canonical sync identity for '${displayPath}'`,
    );
  }
  // Map resolved paths to canonical sync identities used by specific editors
  // (e.g. ipynb syncdb path, terminal path key).
  return canonicalPath(syncPath, projectHome);
}

export async function resolveSyncPathWithRetry(
  fs: SyncIdentityFs,
  displayPath: string,
  projectHome: string,
  {
    isOpen = () => true,
  }: {
    isOpen?: () => boolean;
  } = {},
): Promise<string> {
  let syncPath = "";
  await until(
    async () => {
      if (!isOpen()) {
        throw new Error("canonical sync identity open was cancelled");
      }
      try {
        syncPath = await resolveSyncPath(fs, displayPath, projectHome);
        return true;
      } catch (err) {
        if (!isTransientSyncIdentityResolutionError(err)) {
          throw err;
        }
        return false;
      }
    },
    {
      start: SYNC_IDENTITY_RETRY_START_MS,
      max: SYNC_IDENTITY_RETRY_MAX_MS,
    },
  );
  return syncPath;
}

export async function open_file(
  actions: ProjectActions,
  opts: OpenFileOpts,
): Promise<void> {
  // console.log("open_file: ", opts);

  const foreground = opts.foreground ?? true;
  const foreground_project = opts.foreground_project ?? foreground;
  const wait_for_ready = opts.wait_for_ready ?? foreground;
  opts = defaults(opts, {
    path: required,
    ext: undefined,
    line: undefined,
    fragmentId: undefined,
    foreground,
    foreground_project,
    wait_for_ready,
    chat: undefined,
    chat_width: undefined,
    ignore_kiosk: false,
    new_browser_window: false,
    change_history: true,
    explicit: false,
    workspaceSelection: undefined,
  });
  const projectHome = getProjectHomeDirectory(actions.project_id);
  const hadTrailingSlash = opts.path.endsWith("/");
  opts.path = toAbsoluteOpenPath(opts.path, projectHome);
  if (hadTrailingSlash) {
    actions.open_directory(opts.path);
    return;
  }
  opts.path = normalize(opts.path);
  const displayPath = opts.path;
  const publicDirectoryShareOpen = isPublicDirectoryShareOpen(actions);
  if (publicDirectoryShareOpen) {
    // Share routes are aliases for path-scoped viewer access. Never let a
    // share file open switch the browser to the normal project URL.
    opts.foreground_project = false;
    opts.change_history = false;
    if (opts.foreground) {
      updatePublicDirectoryShareUrl(actions, displayPath, projectHome, {
        replace: !opts.explicit,
      });
    }
  }
  if (opts.foreground) {
    applyWorkspaceSelectionForForegroundOpen(
      actions.project_id,
      displayPath,
      opts.workspaceSelection,
    );
  }

  if (opts.line != null && !opts.fragmentId) {
    // backward compat
    opts.fragmentId = { line: `${opts.line}` };
  }

  const is_kiosk = () =>
    !opts.ignore_kiosk &&
    (redux.getStore("page") as any).get("fullscreen") === "kiosk";

  if (opts.new_browser_window) {
    // TODO: options other than path are ignored right now.
    // if there is no path, we open the entire project and want
    // to show the tabs – unless in kiosk mode
    const fullscreen = is_kiosk() ? "kiosk" : opts.path ? "default" : "";
    actions.open_in_new_browser_window(opts.path, fullscreen);
    return;
  }

  // For foreground opens, ensure the project is opened so startup UI appears.
  // For background opens, do not call open_project here since it can alter
  // the current file listing target.
  if (opts.foreground_project) {
    redux.getActions("projects").open_project({
      project_id: actions.project_id,
      switch_to: true,
    });
  }

  const tabIsOpened = () =>
    !!actions.get_store()?.get("open_files")?.has(displayPath);
  const workingDirectory = (path = displayPath) =>
    workingDirectoryForProjectFile(path, {
      projectHomeDirectory: projectHome,
      workspaceRecords: getRuntimeWorkspaceRecords(actions.project_id),
    });
  const hasComponentBootstrap = () =>
    actions.get_store()?.getIn(["open_files", displayPath, "component"]) !=
    null;
  // A row can exist in open_files without component/ext bootstrap (e.g. partial
  // session restore or failed editor initialization). Treat that as not-open so
  // this call fully hydrates the tab instead of leaving it on perpetual Loading...
  const alreadyOpened = tabIsOpened() && hasComponentBootstrap();

  if (!alreadyOpened) {
    // Make the visible tab itself appear ASAP (just the tab at the top,
    // not the file contents), even though
    // some stuff that may await below needs to happen.
    // E.g., if the user elects not to start the project, or
    // we have to resolve a symlink instead, then we *fix*
    // that below!  This makes things fast and predictable
    // usually.
    if (!actions.open_files) {
      return;
      // closed
    }
    actions.open_files.set(displayPath, "display_path", displayPath);
    if (opts.foreground || opts.wait_for_ready || PRELOAD_BACKGROUND_TABS) {
      actions.open_files.set(displayPath, "component", {});
    }
  }

  if (!opts.foreground && !opts.wait_for_ready && !PRELOAD_BACKGROUND_TABS) {
    // Session restore and other lazy background opens should only recreate the
    // tab row. Hydrating the editor here stampedes project/file initialization
    // on browser refresh.
    actions.open_files?.set(displayPath, "fragmentId", opts.fragmentId ?? "");
    redux.getActions("page").save_session();
    return;
  }

  // intercept any requests to open files with an error when in kiosk mode
  if (is_kiosk() && !alreadyOpened) {
    alert_message({
      type: "error",
      message: `CoCalc is in Kiosk mode, so you may not open "${opts.path}".  Please try visiting ${document.location.origin} directly.`,
      timeout: 15,
    });
    return;
  }

  if (
    opts.fragmentId == null &&
    !alreadyOpened &&
    location.hash.slice(1) &&
    opts.foreground
  ) {
    // If you just opened a file and location.hash is set and in foreground, go to
    // that location.  Do NOT do this if opts.foreground not set, e.g,. when restoring
    // session, because then all background files are configured to open with that
    // fragment.
    opts.fragmentId = Fragment.decode(location.hash);
  }

  if (!tabIsOpened()) {
    return;
  }

  if (isViewerProjectOpen(actions)) {
    const changeHistory = publicDirectoryShareOpen
      ? false
      : opts.change_history;
    const ext = opts.ext ?? filename_extension(displayPath).toLowerCase();
    let syncPath = displayPath;
    try {
      syncPath = await resolveSyncPathWithRetry(
        actions.fs() as SyncIdentityFs,
        displayPath,
        projectHome,
        { isOpen: tabIsOpened },
      );
    } catch (err) {
      if (isCancelledSyncIdentityResolutionError(err)) {
        return;
      }
      // The viewer fs service still enforces path policy on every read. Keep
      // opening by display path if canonical identity resolution is temporarily
      // unavailable, instead of falling back to collaborator realtime.
      syncPath = displayPath;
    }
    actions.open_files?.set(displayPath, "ext", ext);
    actions.open_files?.set(displayPath, "component", {});
    actions.open_files?.set(displayPath, "sync_path", syncPath);
    actions.open_files?.set(displayPath, "chat_width", opts.chat_width);
    actions.open_files?.set(displayPath, "display_path", displayPath);
    actions.open_files?.set(displayPath, "fragmentId", opts.fragmentId ?? "");
    redux.getActions("page").save_session();
    if (opts.foreground) {
      actions.set_current_path(workingDirectory());
      if (!publicDirectoryShareOpen) {
        actions.foreground_project(changeHistory);
      }
      actions.set_active_tab(path_to_tab(displayPath), {
        change_history: changeHistory,
      });
    }
    return;
  }

  const continueOpen = async (): Promise<void> => {
    let syncPath: string;
    try {
      syncPath = await resolveSyncPathWithRetry(
        actions.fs() as SyncIdentityFs,
        displayPath,
        projectHome,
        {
          isOpen: tabIsOpened,
        },
      );
    } catch (err) {
      if (isCancelledSyncIdentityResolutionError(err)) {
        return;
      }
      if (!alreadyOpened && actions.open_files?.has(displayPath)) {
        actions.open_files.delete(displayPath);
        redux.getActions("page").save_session();
      }
      if (shouldSuppressArchivedOpenError(actions.project_id)) {
        return;
      }
      alert_message({
        type: "error",
        message: `Cannot safely open "${displayPath}" because canonical sync identity resolution failed: ${err}`,
        timeout: 10,
      });
      return;
    }
    if (!tabIsOpened()) {
      return;
    }
    if (actions.open_files != null) {
      actions.open_files.set(displayPath, "sync_path", syncPath);
      actions.open_files.set(displayPath, "display_path", displayPath);
    }
    // If this path resolves to a sync identity that is already open in this browser,
    // don't keep a second tab with the same realtime session key.
    const alreadyOpenAliasPath = alreadyOpened
      ? undefined
      : findOpenDisplayPathForSyncPath(actions, syncPath, displayPath);
    if (alreadyOpenAliasPath != null) {
      if (actions.open_files?.has(displayPath)) {
        actions.open_files.delete(displayPath);
      }
      redux.getActions("page").save_session();
      if (opts.foreground) {
        actions.set_current_path(workingDirectory(alreadyOpenAliasPath));
        actions.foreground_project(opts.change_history);
        actions.set_active_tab(path_to_tab(alreadyOpenAliasPath), {
          change_history: opts.change_history,
        });
      }
      if (opts.chat) {
        actions.open_chat({ path: alreadyOpenAliasPath });
      }
      if (opts.fragmentId != null) {
        actions.gotoFragment(alreadyOpenAliasPath, opts.fragmentId);
      }
      alert_message({
        type: "info",
        message: `"${displayPath}" is already open as "${alreadyOpenAliasPath}". Switched to that tab.`,
        timeout: 4,
      });
      return;
    }
    // Editor selection must use the user-facing file path extension.
    // syncPath may be canonicalized to backend identities, which are not
    // necessarily editor extensions.
    let ext = opts.ext ?? filename_extension(displayPath).toLowerCase();

    let store = actions.get_store();
    if (store == null) {
      return;
    }

    // Wait for the project to start opening.
    try {
      await ensureProjectIsOpenWithRetry(actions, {
        foreground_project: opts.foreground_project,
        isOpen: tabIsOpened,
      });
      if (!tabIsOpened()) {
        return;
      }
    } catch (err) {
      if (isCancelledProjectOpenRetryError(err)) {
        return;
      }
      actions.set_activity({
        id: uuid(),
        error: `Error opening file '${displayPath}' (error ensuring project is open) -- ${err}`,
      });
      return;
    }
    if (!tabIsOpened()) {
      return;
    }

    if (ext === "sagews") {
      await open_sagews_worksheet(actions, opts);
      return;
    }

    get_side_chat_state(actions.project_id, opts);

    store = actions.get_store(); // because async stuff happened above.
    if (store == undefined) {
      return;
    }

    // Only generate the editor component if we don't have it already.
    if (store.get("open_files") == null || actions.open_files == null) {
      // project is closing
      return;
    }

    if (!alreadyOpened) {
      // Add it to open files
      actions.open_files.set(displayPath, "ext", ext);
      actions.open_files.set(displayPath, "component", {});
      actions.open_files.set(displayPath, "chat_width", opts.chat_width);
      actions.open_files.set(displayPath, "sync_path", syncPath);
      actions.open_files.set(displayPath, "display_path", displayPath);
      if (opts.chat) {
        actions.open_chat({ path: displayPath });
      }

      redux.getActions("page").save_session();
    }

    actions.open_files.set(displayPath, "fragmentId", opts.fragmentId ?? "");

    void opts.explicit;

    if (!tabIsOpened()) {
      return;
    }

    if (opts.foreground) {
      actions.foreground_project(opts.change_history);
      const tab = path_to_tab(displayPath);
      actions.set_active_tab(tab, {
        change_history: opts.change_history,
      });
    } else if (PRELOAD_BACKGROUND_TABS) {
      await actions.initFileRedux(syncPath);
    }

    if (alreadyOpened && opts.chat) {
      actions.open_chat({ path: displayPath, width: opts.chat_width });
    }

    if (alreadyOpened && opts.fragmentId) {
      // when file already opened we have to explicitly do this, since
      // it doesn't happen in response to foregrounding the file the
      // first time.
      actions.gotoFragment(displayPath, opts.fragmentId);
    }
  };

  if (!opts.wait_for_ready) {
    void continueOpen().catch((err) => {
      if (!tabIsOpened()) {
        return;
      }
      actions.set_activity({
        id: uuid(),
        error: `Error opening file '${displayPath}' -- ${err}`,
      });
    });
    return;
  }

  await continueOpen();
}

function isViewerProjectOpen(actions: ProjectActions): boolean {
  if (isPublicDirectoryShareOpen(actions)) {
    return true;
  }
  const account_id = redux.getStore("account")?.get("account_id");
  if (!account_id) return false;
  return isViewerProjectRole(
    getProjectUserRole({
      account_id,
      project_id: actions.project_id,
      projectsStore: redux.getStore("projects") as any,
    }),
  );
}

function isPublicDirectoryShareOpen(actions: ProjectActions): boolean {
  return !!`${
    actions.get_store?.()?.get("public_directory_share_id") ?? ""
  }`.trim();
}

function updatePublicDirectoryShareUrl(
  actions: ProjectActions,
  displayPath: string,
  projectHome: string,
  { replace }: { replace: boolean },
): void {
  if (typeof window === "undefined") return;
  const store = actions.get_store?.();
  const slug = `${store?.get("public_directory_share_slug") ?? ""}`.trim();
  const sharePath = `${store?.get("public_directory_share_path") ?? ""}`
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!slug || !sharePath) return;
  const shareRoot =
    sharePath === "."
      ? projectHome
      : normalize(toAbsoluteProjectPath(sharePath, projectHome));
  const relativePath = relative(shareRoot, displayPath).replace(/\\/g, "/");
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("/")
  ) {
    return;
  }
  const encodePath = (value: string) =>
    value
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/");
  const slugPath = encodePath(slug);
  const relativeRoute = encodePath(relativePath);
  const nextPath = relativeRoute
    ? `/share/${slugPath}/${relativeRoute}`
    : `/share/${slugPath}`;
  if (window.location.pathname === nextPath) return;
  if (replace) {
    window.history.replaceState(window.history.state, "", nextPath);
  } else {
    window.history.pushState(window.history.state, "", nextPath);
  }
}

function toAbsoluteOpenPath(path: string, projectHome: string): string {
  return toAbsoluteProjectPath(path, projectHome);
}

async function open_sagews_worksheet(
  actions: ProjectActions,
  opts: OpenFileOpts,
): Promise<void> {
  const ipynb_path = opts.path.replace(/\.sagews$/i, ".ipynb");
  const clear_sagews_tab = async () => {
    if (!actions.open_files?.has(opts.path)) {
      return;
    }
    actions.open_files.delete(opts.path);
    await remove(opts.path, redux, actions.project_id);
  };

  try {
    if (!(await file_exists(actions.project_id, ipynb_path))) {
      alert_message({
        type: "info",
        message: `Converting '${opts.path}' to a Jupyter notebook...`,
      });
      const raw = await webapp_client.project_client.read_text_file({
        project_id: actions.project_id,
        path: opts.path,
      });
      const { default: sagewsToIpynb } =
        await import("@cocalc/frontend/frame-editors/sagews-editor/sagews-to-ipynb");
      const ipynb = sagewsToIpynb(raw);
      await webapp_client.project_client.write_text_file({
        project_id: actions.project_id,
        path: ipynb_path,
        content: JSON.stringify(ipynb, undefined, 2),
      });
    }
    await clear_sagews_tab();
    const { ext: _ext, ...open_opts } = opts;
    await open_file(actions, { ...open_opts, path: ipynb_path });
  } catch (err) {
    await clear_sagews_tab();
    alert_message({
      type: "error",
      message: `Error converting legacy worksheet -- ${err}`,
    });
  }
}

async function file_exists(project_id: string, path: string): Promise<boolean> {
  const f = path_split(path);
  try {
    await webapp_client.project_client.exec({
      project_id,
      command: "test",
      args: ["-e", f.tail],
      path: f.head,
      err_on_exit: true,
    });
    return true;
  } catch (err) {
    return false;
  }
}

export type OpenPhase =
  | "open_start"
  | "optimistic_ready"
  | "read_only_reload"
  | "sync_ready"
  | "handoff_done"
  | "handoff_differs";

type OpenPhaseDetails = {
  [key: string]: string | number | boolean | undefined;
};

interface OpenTiming {
  id: string;
  project_id: string;
  path: string;
  wallStart: number;
  uxStart: number;
  visibilityEpoch: number;
  startedHidden: boolean;
  marks: Partial<Record<OpenPhase, number>>;
  lastPhase?: OpenPhase;
  lastPhaseDetails?: OpenPhaseDetails;
  opened_time_ms?: number;
  deleted?: number;
  opened_time_logged: boolean;
  ux_latency_logged?: {
    visible?: boolean;
    sync_ready?: boolean;
  };
}

const log_open_time: { [path: string]: OpenTiming } = {};
const FILE_OPEN_STALE_AFTER_MS = 60_000;
const FILE_OPEN_WALL_CLOCK_SKEW_MS = 10_000;
let visibilityEpoch = 0;
let visibilityListenerInstalled = false;

function getVisibilityEpoch(): number {
  if (typeof document === "undefined") return visibilityEpoch;
  if (!visibilityListenerInstalled) {
    visibilityListenerInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        visibilityEpoch += 1;
      }
    });
  }
  return visibilityEpoch;
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function openTimingKey(project_id: string, path: string): string {
  return `${project_id}-${normalize(path)}`;
}

function getOpenTiming(
  project_id: string,
  path: string,
): OpenTiming | undefined {
  const normalizedPath = normalize(path);
  const normalizedKey = `${project_id}-${normalizedPath}`;
  const direct = log_open_time[normalizedKey];
  if (direct != null) {
    return direct;
  }
  // Backward-compat for entries keyed before normalization.
  const legacyKey = `${project_id}-${path}`;
  const legacy = log_open_time[legacyKey];
  if (legacy != null) {
    log_open_time[normalizedKey] = legacy;
    delete log_open_time[legacyKey];
    return legacy;
  }
  return undefined;
}

function maybeCleanupOpenTiming(project_id: string, path: string): void {
  const key = openTimingKey(project_id, path);
  const data = log_open_time[key];
  if (data == null || !data.opened_time_logged) return;
  const hasOptimistic = data.marks.optimistic_ready != null;
  const finalPhase =
    data.marks.handoff_done != null ||
    (!hasOptimistic && data.marks.sync_ready != null);
  if (finalPhase) {
    delete log_open_time[key];
  }
}

function buildOpenUpdateEvent(
  data: OpenTiming,
  phase?: OpenPhase,
  elapsed_ms?: number,
): any {
  const event: any = {
    event: "open",
    action: "open",
    filename: data.path,
    open_phase_marks_ms: { ...data.marks },
  };
  const effectivePhase = phase ?? data.lastPhase;
  if (effectivePhase != null) {
    event.open_phase = effectivePhase;
    event.open_phase_elapsed_ms = elapsed_ms ?? data.marks[effectivePhase];
  }
  if (data.lastPhaseDetails != null) {
    event.open_phase_details = data.lastPhaseDetails;
  }
  if (data.opened_time_ms != null) {
    event.time = data.opened_time_ms;
  }
  if (data.deleted != null) {
    event.deleted = data.deleted;
  }
  return event;
}

function fileOpenSegment(data: OpenTiming): string {
  const ext = filename_extension(data.path).toLowerCase();
  return ext ? `.${ext}` : "no-extension";
}

function recordFileOpenUxLatency(
  data: OpenTiming,
  metric: "file_open_visible" | "file_open_sync_ready",
  elapsed_ms: number,
  phase?: OpenPhase,
): void {
  data.ux_latency_logged ??= {};
  const flag = metric === "file_open_visible" ? "visible" : "sync_ready";
  if (data.ux_latency_logged[flag]) return;
  data.ux_latency_logged[flag] = true;
  const wallElapsedMs = Date.now() - data.wallStart;
  const hiddenDuringOpen =
    data.startedHidden ||
    isDocumentHidden() ||
    getVisibilityEpoch() !== data.visibilityEpoch;
  const wallClockSkewMs = wallElapsedMs - elapsed_ms;
  const staleReason =
    elapsed_ms > FILE_OPEN_STALE_AFTER_MS
      ? "elapsed_exceeded_cap"
      : hiddenDuringOpen
        ? "page_hidden"
        : wallClockSkewMs > FILE_OPEN_WALL_CLOCK_SKEW_MS
          ? "wall_clock_skew"
          : undefined;
  const ext = filename_extension(data.path).toLowerCase();
  recordUxLatencyEvent({
    event_type: "file_open",
    metric: staleReason == null ? metric : `${metric}_stale`,
    duration_ms: elapsed_ms,
    project_id: data.project_id,
    client_event_id: data.id,
    path_ext: ext ? `.${ext}` : undefined,
    segment: fileOpenSegment(data),
    details: {
      phase,
      marks: data.marks,
      ...(staleReason == null
        ? {}
        : {
            stale_reason: staleReason,
            raw_duration_ms: elapsed_ms,
            wall_elapsed_ms: wallElapsedMs,
            wall_clock_skew_ms: wallClockSkewMs,
          }),
      ...(data.lastPhaseDetails ?? {}),
    },
  });
}

export function restart_open_timer(
  project_id: string,
  path: string,
  details?: OpenPhaseDetails,
): void {
  const data = getOpenTiming(project_id, path);
  if (data == null) return;
  data.wallStart = Date.now();
  data.uxStart = startUxTimer();
  data.visibilityEpoch = getVisibilityEpoch();
  data.startedHidden = isDocumentHidden();
  data.marks = {};
  data.lastPhase = undefined;
  data.lastPhaseDetails = details;
  data.opened_time_ms = undefined;
  data.marks.open_start = 0;
  data.opened_time_logged = false;
}

export function mark_open_phase(
  project_id: string,
  path: string,
  phase: OpenPhase,
  details?: OpenPhaseDetails,
): void {
  path = normalize(path);
  const data = getOpenTiming(project_id, path);
  if (data == null) return;
  const elapsed_ms = elapsedUxMs(data.uxStart);
  data.marks[phase] = elapsed_ms;
  data.lastPhase = phase;
  if (details != null) {
    data.lastPhaseDetails = details;
  }
  if (phase === "optimistic_ready") {
    recordFileOpenUxLatency(data, "file_open_visible", elapsed_ms, phase);
  }
  if (phase === "sync_ready" || phase === "handoff_done") {
    recordFileOpenUxLatency(data, "file_open_sync_ready", elapsed_ms, phase);
  }
  const event = buildOpenUpdateEvent(data, phase, elapsed_ms);
  redux.getProjectActions(project_id).log(event, data.id);
  maybeCleanupOpenTiming(project_id, path);
}

export function log_file_open(
  project_id: string,
  path: string,
  deleted?: number,
): void {
  path = normalize(path);
  // Only do this if the file isn't
  // deleted, since if it *is* deleted, then user sees a dialog
  // and we only log the open if they select to recreate the file.
  // See https://github.com/sagemathinc/cocalc/issues/4720
  if (!deleted && webapp_client.file_client.is_deleted(path, project_id)) {
    return;
  }

  redux.getActions("document_activity")?.mark_file(project_id, path, "open");
  const actions = redux.getProjectActions(project_id);
  const id = actions.log({
    event: "open",
    action: "open",
    filename: path,
    deleted,
  });

  // Save the log entry id, so it is possible to optionally
  // record how long it took for the file to open.  This
  // may happen via a call from random places in our codebase,
  // since the idea of "finishing opening and rendering" is
  // not simple to define.
  if (id !== undefined) {
    const key = openTimingKey(project_id, path);
    log_open_time[key] = {
      id,
      project_id,
      path,
      wallStart: Date.now(),
      uxStart: startUxTimer(),
      visibilityEpoch: getVisibilityEpoch(),
      startedHidden: isDocumentHidden(),
      marks: { open_start: 0 },
      lastPhaseDetails: undefined,
      lastPhase: undefined,
      opened_time_ms: undefined,
      deleted,
      opened_time_logged: false,
      ux_latency_logged: {},
    };
  }
}

export function log_opened_time(project_id: string, path: string): void {
  // Call log_opened with a path to update the log with the fact that
  // this file successfully opened and rendered so that the user can
  // actually see it.  This is used to get a sense for how long things
  // are taking...
  path = normalize(path);
  const data = getOpenTiming(project_id, path);
  if (data == null) {
    // never setup log event recording the start of open (this would get set in @open_file)
    return;
  }
  if (data.opened_time_logged) {
    return;
  }
  const { id } = data;
  const actions = redux.getProjectActions(project_id);
  const time = elapsedUxMs(data.uxStart);
  data.opened_time_logged = true;
  data.opened_time_ms = time;
  recordFileOpenUxLatency(data, "file_open_visible", time, data.lastPhase);
  actions.log(buildOpenUpdateEvent(data), id);
  maybeCleanupOpenTiming(project_id, path);
}

// This modifies the opts object passed into it:
function get_side_chat_state(
  project_id: string,
  opts: {
    path: string;
    chat?: boolean;
    chat_width?: number;
  },
): void {
  // grab chat state from local storage
  if (local_storage != null) {
    if (opts.chat == null) {
      opts.chat = local_storage(project_id, opts.path, "chatState");
    }
    if (opts.chat_width == null) {
      opts.chat_width = local_storage(project_id, opts.path, "chat_width");
    }
  }

  if (isChatExtension(filename_extension(opts.path))) {
    opts.chat = false;
  }
}

export function canonicalPath(path: string, projectHome = "/") {
  return canonicalSyncPath(path, projectHome);
}
