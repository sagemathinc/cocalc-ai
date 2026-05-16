/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// TODO: we should refactor our code to not have these window/document references here.
declare let window, document;

import { callback } from "awaiting";
import { List, Map, fromJS } from "immutable";
import { throttle } from "lodash";
import { join } from "path";
import { defineMessage } from "react-intl";
import type { IconName } from "@cocalc/frontend/components/icon";
import { get as getProjectStatus } from "@cocalc/conat/project/project-status";
import { default_filename } from "@cocalc/frontend/account";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  Actions,
  project_redux_name,
  redux,
  redux_name,
} from "@cocalc/frontend/app-framework";
import type { ChatState } from "@cocalc/frontend/chat/chat-indicator";
import {
  initChat,
  remove as removeChatRuntime,
} from "@cocalc/frontend/chat/register";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { local_storage } from "@cocalc/frontend/editor-local-storage";
import { set_url } from "@cocalc/frontend/history";
import {
  download_file,
  open_new_tab,
  open_popup_window,
} from "@cocalc/frontend/misc";
import Fragment, { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import * as project_file from "@cocalc/frontend/project-file";
import { ProjectEvent } from "@cocalc/frontend/project/history/types";
import {
  OpenFileOpts,
  log_file_open,
  log_opened_time,
  open_file,
} from "@cocalc/frontend/project/open-file";
import { OpenFiles } from "@cocalc/frontend/project/open-files";
import { FixedTab } from "@cocalc/frontend/project/page/file-tab";
import {
  FlyoutActiveMode,
  FlyoutLogDeduplicate,
  FlyoutLogMode,
  storeFlyoutState,
} from "@cocalc/frontend/project/page/flyouts/state";
import {
  PROJECT_PAGE_ATTRIBUTE,
  focusProjectFileTabStrip,
  getAdjacentOpenFilePath,
} from "@cocalc/frontend/project/page/keyboard-navigation";
import {
  FLYOUT_LOG_FILTER_DEFAULT,
  FlyoutLogFilter,
} from "@cocalc/frontend/project/page/flyouts/utils";
import { getValidActivityBarOption } from "@cocalc/frontend/project/page/activity-bar";
import { ACTIVITY_BAR_KEY } from "@cocalc/frontend/project/page/activity-bar-consts";
import {
  getActivityBarCollapsed,
  setActivityBarCollapsed,
} from "@cocalc/frontend/project/page/activity-bar-storage";
import { ensure_project_running } from "@cocalc/frontend/project/project-start-warning";
import { transform_get_url } from "@cocalc/frontend/project/transform-get-url";
import {
  NewFilenames,
  download_href,
  normalize,
  url_href,
} from "@cocalc/frontend/project/utils";
import { API } from "@cocalc/frontend/project/websocket/api";
import { disconnect_from_project } from "@cocalc/frontend/project/websocket/connect";
import {
  Configuration,
  ConfigurationAspect,
  ProjectConfiguration,
  is_available as feature_is_available,
  get_configuration,
} from "@cocalc/frontend/project_configuration";
import { ModalInfo, ProjectStore, ProjectStoreState } from "./store";
import track from "@cocalc/frontend/user-tracking";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  acquireSharedProjectDStream,
  type SharedProjectDStreamRelease,
} from "@cocalc/frontend/conat/project-dstream";
import { once, retry_until_success } from "@cocalc/util/async-utils";
import { DEFAULT_NEW_FILENAMES, NEW_FILENAMES } from "@cocalc/util/db-schema";
import * as misc from "@cocalc/util/misc";
import { reduxNameToProjectId } from "@cocalc/util/redux/name";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import type { DStream } from "@cocalc/conat/sync/dstream";
import {
  PROJECT_LOG_STREAM_NAME,
  type ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import {
  getCacheId,
  getFiles,
  type Files,
} from "@cocalc/frontend/project/listing/use-files";
import { search } from "@cocalc/frontend/project/search/run";
import { type CopyOptions } from "@cocalc/conat/files/fs";
import { CopyOpsManager } from "@cocalc/frontend/project/copy-ops";
import { BackupOpsManager } from "@cocalc/frontend/project/backup-ops";
import { RestoreOpsManager } from "@cocalc/frontend/project/restore-ops";
import { RootfsPublishOpsManager } from "@cocalc/frontend/project/rootfs-publish-ops";
import { MoveOpsManager } from "@cocalc/frontend/project/move-ops";
import { StartOpsManager } from "@cocalc/frontend/project/start-ops";
import { isCollaboratorRealtimeAccessError } from "@cocalc/frontend/project/collaborator-realtime";
import { canUseCollaboratorProjectRealtime } from "@cocalc/frontend/project/realtime-access";
import { getSearch } from "@cocalc/frontend/project/explorer/config";
import dust from "@cocalc/frontend/project/disk-usage/dust";
import { withProjectHostBase } from "@cocalc/frontend/project/host-url";
import { EditorLoadError } from "../../file-editors-error";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { isJupyterPath } from "@cocalc/util/jupyter/names";
import { canonicalSyncPath } from "@cocalc/frontend/project/sync-path";
import {
  getProjectUrlPath,
  parseProjectTarget,
} from "@cocalc/frontend/project-routing";
import {
  buildProjectLogMap,
  mergeProjectLogMap,
  newestProjectLogCursor,
  oldestProjectLogCursor,
} from "@cocalc/frontend/project/log-state";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import { createSharedLroListClient } from "@cocalc/frontend/lro/shared-list";
import {
  buildProjectLogRowsFromStream,
  filterProjectLogRows,
  pageProjectLogRows,
} from "./project-log";
import { callFilesystemClientWithRecovery } from "./filesystem-client";
import {
  resetOpenFileRuntimeAfterHostReset,
  selectOpenFilesForSyncPath,
} from "./open-file-runtime";
import {
  copyPathBetweenProjects,
  copyPaths,
  deleteFiles,
  deleteMatchingFiles,
  moveFiles,
  renameFile,
} from "./file-operations";
import {
  constructAbsolutePath,
  createFile as createProjectFile,
  createFolder as createProjectFolder,
  ensureContainingDirectoryExists as ensureProjectContainingDirectoryExists,
  ensureDirectoryExists as ensureProjectDirectoryExists,
} from "./file-creation";
import {
  isVirtualListingPath,
  toAbsoluteCurrentPath,
  toAuxTabPath,
  toUrlPath,
  fromUrlDirectoryPath,
} from "./path-routing";
import {
  nextSelectedFileIndex,
  selectedFileRange,
  setFileCheckedState,
  setFileListCheckedState,
  setFileListUncheckedState,
  suggestDuplicateFilenameInDirectory,
  uniqueFileActionPaths,
} from "./file-selection";
export { callFilesystemClientWithRecovery } from "./filesystem-client";
export { resetOpenFileRuntimeAfterHostReset } from "./open-file-runtime";

const { defaults, required } = misc;

const FROM_WEB_TIMEOUT_S = 45;
const PROJECT_LOG_BATCH_LIMIT = 750;

export const QUERIES = {
  project_log: {
    query: {
      id: null,
      project_id: null,
      account_id: null,
      time: null,
      event: null,
    },
  },

  project_log_all: {
    query: {
      id: null,
      project_id: null,
      account_id: null,
      time: null,
      event: null,
    },
  },
};

const must_define = function (redux) {
  if (redux == null) {
    throw Error(
      "you must explicitly pass a redux object into each function in project_store",
    );
  }
};

export const FILE_ACTIONS = {
  compress: {
    name: defineMessage({
      id: "file_actions.compress.name",
      defaultMessage: "Compress",
      description: "Compress a file",
    }),
    icon: "compress" as IconName,
    allows_multiple_files: true,
    hideFlyout: false,
  },
  delete: {
    name: defineMessage({
      id: "file_actions.delete.name",
      defaultMessage: "Delete",
      description: "Delete a file",
    }),
    icon: "trash" as IconName,
    allows_multiple_files: true,
    hideFlyout: false,
  },
  rename: {
    name: defineMessage({
      id: "file_actions.rename.name",
      defaultMessage: "Rename",
      description: "Rename a file",
    }),
    icon: "swap" as IconName,
    allows_multiple_files: false,
    hideFlyout: false,
  },
  duplicate: {
    name: defineMessage({
      id: "file_actions.duplicate.name",
      defaultMessage: "Duplicate",
      description: "Duplicate a file",
    }),
    icon: "clone" as IconName,
    allows_multiple_files: false,
    hideFlyout: false,
  },
  move: {
    name: defineMessage({
      id: "file_actions.move.name",
      defaultMessage: "Move",
      description: "Move a file",
    }),
    icon: "move" as IconName,
    allows_multiple_files: true,
    hideFlyout: false,
  },
  copy: {
    name: defineMessage({
      id: "file_actions.copy.name",
      defaultMessage: "Copy",
      description: "Copy a file",
    }),
    icon: "files" as IconName,
    allows_multiple_files: true,
    hideFlyout: false,
  },
  download: {
    name: defineMessage({
      id: "file_actions.download.name",
      defaultMessage: "Download",
      description: "Download a file",
    }),
    icon: "cloud-download" as IconName,
    allows_multiple_files: true,
    hideFlyout: false,
  },
  upload: {
    name: defineMessage({
      id: "file_actions.upload.name",
      defaultMessage: "Upload",
      description: "Upload a file",
    }),
    icon: "upload" as IconName,
    allows_multiple_files: false,
    hideFlyout: true,
  },
  create: {
    name: defineMessage({
      id: "file_actions.create.name",
      defaultMessage: "Create",
      description: "Create a file",
    }),
    icon: "plus-circle" as IconName,
    allows_multiple_files: false,
    hideFlyout: true,
  },
} as const;

export type FileAction = keyof typeof FILE_ACTIONS;

export class ProjectActions extends Actions<ProjectStoreState> {
  public state: "ready" | "closed" = "ready";
  public project_id: string;
  private _last_history_state: string;
  private _activity_indicator_timers: { [key: string]: number } = {};
  private _init_done = false;
  private new_filename_generator = new NewFilenames("", false);
  private modal?: ModalInfo;

  // these are all potentially expensive
  public open_files?: OpenFiles;
  private projectStatusSub?;
  private projectLogStream?: DStream<ProjectLogRow>;
  private releaseProjectLogStream?: SharedProjectDStreamRelease;
  private copyOpsManager: CopyOpsManager;
  private backupOpsManager: BackupOpsManager;
  private restoreOpsManager: RestoreOpsManager;
  private rootfsPublishOpsManager: RootfsPublishOpsManager;
  private startOpsManager: StartOpsManager;
  private moveOpsManager: MoveOpsManager;
  private collaboratorRealtimeInitialized = false;
  private collaboratorRealtimeDenied = false;
  private collaboratorRealtimeRetryTimer?: ReturnType<typeof setTimeout>;
  private collaboratorRealtimeRetryCount = 0;

  constructor(name, b) {
    super(name, b);
    this.project_id = reduxNameToProjectId(name);
    this.open_files = new OpenFiles(this);
    const listProjectLro = createSharedLroListClient({
      listLro: (opts) => webapp_client.conat_client.hub.lro.list(opts),
    });
    this.copyOpsManager = new CopyOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    this.backupOpsManager = new BackupOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    this.restoreOpsManager = new RestoreOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    this.rootfsPublishOpsManager = new RootfsPublishOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    this.startOpsManager = new StartOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    this.moveOpsManager = new MoveOpsManager({
      project_id: this.project_id,
      setState: (state) => this.setState(state),
      isClosed: () => this.isClosed(),
      listLro: listProjectLro,
      getLroStream: (opts) => webapp_client.conat_client.lroStream(opts),
      dismissLro: (opts) => webapp_client.conat_client.hub.lro.dismiss(opts),
      log: this.logCollaboratorRealtimeError,
    });
    // console.log("create project actions", this.project_id);
    // console.trace("create project actions", this.project_id)
    this.expensiveLoop();
  }

  // COST -- there's a lot of code all over that may create project actions,
  // e.g., when configuring a course with 150 students, then 150 project actions
  // get created to do various operations.   The big use of project actions
  // though is when an actual tab is open in the UI with projects.
  // So we put actions in two states: 'cheap' and 'expensive'.
  // In the expensive state, there can be extra changefeeds,
  // etc.  In the cheap state we close all that.  When the tab is
  // visibly open in the UI then expensive stuff automatically gets
  // initialized, and when it is closed, it is destroyed.

  // actually open in the UI?
  private lastProjectTabs: List<string> = List([]);
  private lastProjectTabOpenedState = false;
  isTabOpened = () => {
    const store = redux.getStore("projects");
    if (store == null) {
      return false;
    }
    const projectTabs = store.get("open_projects") as List<string> | undefined;
    if (projectTabs == null) {
      return false;
    }
    if (projectTabs.equals(this.lastProjectTabs)) {
      return this.lastProjectTabOpenedState;
    }
    this.lastProjectTabs = projectTabs;
    this.lastProjectTabOpenedState = projectTabs.includes(this.project_id);
    return this.lastProjectTabOpenedState;
  };
  isTabClosed = () => !this.isTabOpened();

  // The expensive part of the actions should NOT exist if and only if
  // the reference count is 0 *AND* the tab is closed.
  private referenceCount = 0;

  incrementReferenceCount = () => {
    this.referenceCount++;
    this.initExpensive();
  };

  decrementReferenceCount = () => {
    if (this.referenceCount <= 0) {
      console.warn(
        "BUG: attempt to decrement project actions reference count below 0",
      );
      return;
    }
    this.referenceCount--;
    if (this.referenceCount <= 0 && !this.isTabOpened()) {
      this.closeExpensive();
    }
  };

  private expensiveLoop = async () => {
    while (this.state != "closed") {
      if (this.isTabOpened() || this.referenceCount > 0) {
        this.initExpensive();
      } else {
        this.closeExpensive();
      }
      const store = redux.getStore("projects");
      if (store != null) {
        await once(store, "change");
      }
    }
  };

  private initialized = false;
  private initExpensive = () => {
    if (this.initialized) {
      this.ensureCollaboratorRealtime();
      return;
    }
    // console.log("initExpensive", this.project_id);
    this.initialized = true;
    this.ensureCollaboratorRealtime();
  };

  private canUseCollaboratorRealtime = (): boolean => {
    if (this.collaboratorRealtimeDenied) {
      return false;
    }
    return this.localProjectMembershipAllowsRealtime();
  };

  private localProjectMembershipAllowsRealtime = (): boolean => {
    return canUseCollaboratorProjectRealtime({
      account_id: webapp_client.account_id,
      is_admin: redux.getStore("account")?.get("is_admin") as
        | boolean
        | undefined,
      project_id: this.project_id,
      projectsStore: redux.getStore("projects") as
        | {
            getIn?: (path: string[]) => unknown;
          }
        | undefined,
    });
  };

  private closeCollaboratorRealtimeSubscriptions = (): void => {
    this.projectStatusSub?.close();
    delete this.projectStatusSub;
    this.copyOpsManager.close();
    this.backupOpsManager.close();
    this.restoreOpsManager.close();
    this.rootfsPublishOpsManager.close();
    this.startOpsManager.close();
    this.moveOpsManager.close();
  };

  private clearCollaboratorRealtimeRetry = (): void => {
    if (this.collaboratorRealtimeRetryTimer != null) {
      clearTimeout(this.collaboratorRealtimeRetryTimer);
      delete this.collaboratorRealtimeRetryTimer;
    }
  };

  private scheduleCollaboratorRealtimeRetry = (): void => {
    if (this.collaboratorRealtimeRetryTimer != null) {
      return;
    }
    const delayMs = Math.min(
      1000 * 2 ** Math.min(this.collaboratorRealtimeRetryCount, 5),
      30_000,
    );
    this.collaboratorRealtimeRetryCount += 1;
    this.collaboratorRealtimeRetryTimer = setTimeout(() => {
      delete this.collaboratorRealtimeRetryTimer;
      if (
        this.state === "closed" ||
        (!this.isTabOpened() && this.referenceCount <= 0)
      ) {
        return;
      }
      this.ensureCollaboratorRealtime();
    }, delayMs);
  };

  private ensureCollaboratorRealtime = () => {
    if (
      this.collaboratorRealtimeInitialized ||
      !this.canUseCollaboratorRealtime()
    ) {
      return;
    }
    this.collaboratorRealtimeInitialized = true;
    this.initProjectStatus();
    this.copyOpsManager.init();
    this.backupOpsManager.init();
    this.restoreOpsManager.init();
    this.rootfsPublishOpsManager.init();
    this.startOpsManager.init();
    this.moveOpsManager.init();
  };

  private logCollaboratorRealtimeError = (
    message: string,
    err?: unknown,
  ): void => {
    if (isCollaboratorRealtimeAccessError(err)) {
      this.handleCollaboratorRealtimeAccessDenied();
      return;
    }
    console.warn(message, err);
  };

  private handleCollaboratorRealtimeAccessDenied = (): void => {
    if (this.localProjectMembershipAllowsRealtime()) {
      // Membership additions can reach the project list before every realtime
      // auth/routing cache has caught up. Keep the tab open and retry instead
      // of treating this transient denial as collaborator removal.
      this.collaboratorRealtimeInitialized = false;
      this.closeCollaboratorRealtimeSubscriptions();
      webapp_client.conat_client.releaseProjectHostRouting({
        project_id: this.project_id,
      });
      this.scheduleCollaboratorRealtimeRetry();
      return;
    }
    if (this.collaboratorRealtimeDenied) {
      return;
    }
    this.collaboratorRealtimeDenied = true;
    this.collaboratorRealtimeInitialized = false;
    this.closeCollaboratorRealtimeSubscriptions();
    (redux.getActions("page") as any)?.close_project_tab?.(this.project_id);
  };

  private closeExpensive = () => {
    if (!this.initialized) return;
    // console.log("closeExpensive", this.project_id);
    this.initialized = false;
    this.collaboratorRealtimeInitialized = false;
    this.collaboratorRealtimeDenied = false;
    this.collaboratorRealtimeRetryCount = 0;
    this.clearCollaboratorRealtimeRetry();
    redux.removeProjectReferences(this.project_id);
    this.closeCollaboratorRealtimeSubscriptions();
    void this.releaseProjectLogStream?.({ immediate: true });
    delete this.projectLogStream;
    delete this.releaseProjectLogStream;
    must_define(this.redux);
    this.close_all_files();
    for (const table in QUERIES) {
      this.remove_table(table);
    }

    const store = this.get_store();
    store?.close_all_tables();
  };

  public async api(): Promise<API> {
    return await webapp_client.project_client.api(this.project_id);
  }

  private getProjectLogStream = reuseInFlight(
    async (): Promise<DStream<ProjectLogRow>> => {
      if (this.projectLogStream && !this.projectLogStream.isClosed()) {
        return this.projectLogStream;
      }
      const lease = await acquireSharedProjectDStream<ProjectLogRow>({
        project_id: this.project_id,
        name: PROJECT_LOG_STREAM_NAME,
        noInventory: true,
        maxListeners: 50,
        requireRouting: true,
      });
      const stream = lease.stream;
      if (this.isClosed()) {
        await lease.release({ immediate: true });
        throw Error("project closed");
      }
      this.projectLogStream = stream;
      this.releaseProjectLogStream = lease.release;
      return stream;
    },
    { createKey: () => "project-log" },
  );

  private resetProjectLogStream = async (): Promise<void> => {
    const release = this.releaseProjectLogStream;
    delete this.projectLogStream;
    delete this.releaseProjectLogStream;
    await release?.({ immediate: true });
  };

  trackStartOp = (op: {
    op_id?: string;
    scope_type?: "project" | "account" | "host" | "hub";
    scope_id?: string;
  }) => {
    this.startOpsManager.track(op);
  };

  trackMoveOp = (op: {
    op_id?: string;
    scope_type?: "project" | "account" | "host" | "hub";
    scope_id?: string;
  }) => {
    this.moveOpsManager.track(op);
  };

  trackBackupOp = (op: {
    op_id?: string;
    scope_type?: "project" | "account" | "host" | "hub";
    scope_id?: string;
  }) => {
    this.backupOpsManager.track(op);
  };

  trackRestoreOp = (op: {
    op_id?: string;
    scope_type?: "project" | "account" | "host" | "hub";
    scope_id?: string;
  }) => {
    this.restoreOpsManager.track(op);
  };

  trackRootfsPublishOp = (op: {
    op_id?: string;
    scope_type?: "project" | "account" | "host" | "hub";
    scope_id?: string;
  }) => {
    this.rootfsPublishOpsManager.track(op);
  };

  dismissMoveLro = (op_id?: string) => {
    this.moveOpsManager.dismiss(op_id);
  };

  isClosed = () => this.state == "closed";

  destroy = (): void => {
    // console.log("destroy project actions", this.project_id);
    if (this.state == "closed") {
      return;
    }
    this.closeExpensive();
    this.open_files?.close();
    delete this.open_files;
    this.state = "closed";
    this.filesystem = undefined;
  };

  private save_session(): void {
    this.redux.getActions("page").save_session();
  }

  remove_table = (table: string): void => {
    this.redux.removeTable(project_redux_name(this.project_id, table));
  };

  // Records in the backend database that we are actively
  // using this project and wakes up the project.
  // This resets the idle timeout, among other things.
  // This is throttled, so multiple calls are spaced out.
  touch = async (): Promise<void> => {
    try {
      await webapp_client.project_client.touch_project(this.project_id);
    } catch (err) {
      // nonfatal.
      console.warn(`unable to touch ${this.project_id} -- ${err}`);
    }
  };

  ensureProjectIsOpen = async (switch_to: boolean = true) => {
    const s = this.redux.getStore("projects");
    if (!s.is_project_open(this.project_id)) {
      this.redux.getActions("projects").open_project({
        project_id: this.project_id,
        switch_to,
      });
      await s.waitUntilProjectIsOpen(this.project_id, 30);
    }
  };

  get_store = (): ProjectStore | undefined => {
    if (this.redux.hasStore(this.name)) {
      return this.redux.getStore<ProjectStoreState, ProjectStore>(this.name);
    } else {
      return undefined;
    }
  };

  clear_all_activity(): void {
    this.setState({ activity: undefined });
  }

  toggle_panel(name: keyof ProjectStoreState, show?: boolean): void {
    if (show != null) {
      this.setState({ [name]: show });
    } else {
      const store = this.get_store();
      if (store == undefined) return;
      this.setState({ [name]: !store.get(name) });
    }
  }

  // if ext == null → hide dialog; otherwise ask for name with given extension
  ask_filename(ext?: string): void {
    if (ext != null) {
      // this is either cached or undefined; that's good enough
      const filenames = this.get_filenames_in_current_dir();
      // this is the type of random name generator
      const acc_store = this.redux.getStore("account") as any;
      const type =
        acc_store?.getIn(["other_settings", NEW_FILENAMES]) ??
        DEFAULT_NEW_FILENAMES;
      this.new_filename_generator.set_ext(ext);
      this.setState({
        new_filename: this.new_filename_generator.gen(type, filenames),
      });
    }
    this.setState({ ext_selection: ext });
  }

  set_new_filename_family(family: string): void {
    const acc_table = redux.getTable("account");
    if (acc_table != null) {
      acc_table.set({ other_settings: { [NEW_FILENAMES]: family } });
    }
  }

  // Canonical HOME comes from project runtime capabilities instead of a
  // launchpad-specific hardcoded path.
  private getHomeDirectoryForPaths = (): string => {
    return getProjectHomeDirectory(this.project_id);
  };

  private isVirtualListingPath = (path: string): boolean => {
    return isVirtualListingPath(path);
  };

  private toAbsoluteCurrentPath = (path: string): string => {
    return toAbsoluteCurrentPath({
      path,
      homeDirectory: this.getHomeDirectoryForPaths(),
    });
  };

  private toUrlPath = (path: string, isDirectory: boolean): string => {
    return toUrlPath({
      path,
      isDirectory,
      homeDirectory: this.getHomeDirectoryForPaths(),
    });
  };

  private fromUrlDirectoryPath = (path: string): string => {
    return fromUrlDirectoryPath({
      path,
      homeDirectory: this.getHomeDirectoryForPaths(),
    });
  };

  private toAuxTabPath = (tab: "new" | "search", path: string): string => {
    return toAuxTabPath({
      tab,
      path,
      homeDirectory: this.getHomeDirectoryForPaths(),
    });
  };

  private replaceFallbackRootWithHome = (homeDirectory: string): void => {
    const store = this.get_store();
    if (store == null) return;
    const normalizedHome = normalizeAbsolutePath(homeDirectory);
    if (normalizedHome === "/") return;

    const nextState: Partial<ProjectStoreState> = {};
    const pathKeys: (keyof ProjectStoreState)[] = [
      "current_path_abs",
      "history_path_abs",
    ];

    for (const key of pathKeys) {
      if (store.get(key) === "/") {
        nextState[key] = normalizedHome as any;
      }
    }

    if (Object.keys(nextState).length > 0) {
      this.setState(nextState);
    }
  };

  private resolveConcreteHomeDirectory = async (): Promise<string> => {
    const knownHome = normalizeAbsolutePath(this.getHomeDirectoryForPaths());
    if (knownHome !== "/") {
      return knownHome;
    }
    try {
      await this.init_configuration("main");
    } catch (err) {
      console.warn(
        "project_actions::resolveConcreteHomeDirectory failed",
        err,
        this.project_id,
      );
    }
    const resolvedHome = normalizeAbsolutePath(this.getHomeDirectoryForPaths());
    if (resolvedHome !== "/") {
      this.replaceFallbackRootWithHome(resolvedHome);
    }
    return resolvedHome;
  };

  set_url_to_path(current_path, hash?: string): void {
    this.push_state(this.toUrlPath(current_path, true), hash);
  }

  _url_in_project(local_url): string {
    return getProjectUrlPath(this.project_id, local_url, {
      encodeProjectTarget: misc.encode_path,
    });
  }

  push_state(local_url?: string, hash?: string): void {
    if (local_url == null) {
      local_url = this._last_history_state ?? "files/";
    }
    this._last_history_state = local_url;
    set_url(this._url_in_project(local_url), hash);
  }

  move_file_tab(opts: { old_index: number; new_index: number }): void {
    if (this.open_files == null) return;
    this.open_files.move(opts);
    this.save_session();
  }

  set_file_tab_order(order: string[]): void {
    if (this.open_files == null) return;
    this.open_files.set_order(order);
    this.save_session();
  }

  // Closes a file tab
  // Also closes file references.
  // path not always defined, see #3440
  public close_tab(path: string | undefined): void {
    if (path == null) return;
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const open_files_order = store.get("open_files_order");
    const active_project_tab = store.get("active_project_tab");
    const closed_index = open_files_order.indexOf(path);
    const { size } = open_files_order;
    if (misc.path_to_tab(path) === active_project_tab) {
      let next_active_tab: string | undefined = undefined;
      if (size === 1) {
        const account_store = this.redux.getStore("account") as any;
        const actBar = account_store?.getIn([
          "other_settings",
          ACTIVITY_BAR_KEY,
        ]);
        const flyoutsDefault = getValidActivityBarOption(actBar) === "flyout";
        next_active_tab = flyoutsDefault ? "home" : "files";
      } else {
        let path: string | undefined;

        if (closed_index === size - 1) {
          path = open_files_order.get(closed_index - 1);
        } else {
          path = open_files_order.get(closed_index + 1);
        }
        if (path != null) {
          next_active_tab = misc.path_to_tab(path);
        }
      }
      if (next_active_tab != null) {
        this.set_active_tab(next_active_tab);
      }
    }
    this.close_file(path);
  }

  public activate_next_file_tab(): boolean {
    return this.activate_adjacent_file_tab(1);
  }

  public activate_previous_file_tab(): boolean {
    return this.activate_adjacent_file_tab(-1);
  }

  private activate_adjacent_file_tab(direction: 1 | -1): boolean {
    const store = this.get_store();
    if (store == undefined) return false;
    const nextPath = getAdjacentOpenFilePath(
      store.get("open_files_order")?.toArray?.() ?? [],
      store.get("active_project_tab"),
      direction,
    );
    if (nextPath == null) return false;
    this.set_active_tab(misc.path_to_tab(nextPath));
    return true;
  }

  public focus_file_tab_strip(): boolean {
    const projectRoot = document.querySelector(
      `[${PROJECT_PAGE_ATTRIBUTE}="${this.project_id}"]`,
    ) as HTMLElement | null;
    return focusProjectFileTabStrip(projectRoot);
  }

  // Expects one of ['files', 'new', 'log', 'search', 'servers', 'settings']
  //            or a file_redux_name
  // Pushes to browser history
  // Updates the URL
  set_active_tab = (
    key: string,
    opts: {
      update_file_listing?: boolean;
      change_history?: boolean;
      new_ext?: string;
      noFocus?: boolean;
    } = {
      update_file_listing: true,
      change_history: true,
    },
  ): void => {
    if (key === "users") {
      key = "settings";
    }
    const store = this.get_store();
    if (store == undefined) return; // project closed
    const prev_active_project_tab = store.get("active_project_tab");
    if (!opts.change_history && prev_active_project_tab === key) {
      // already active -- nothing further to do
      return;
    }
    if (prev_active_project_tab) {
      // do not keep fragment from tab that is being hidden
      Fragment.clear();
    }
    if (
      prev_active_project_tab !== key &&
      prev_active_project_tab.startsWith("editor-")
    ) {
      this.hide_file(misc.tab_to_path(prev_active_project_tab));
    }
    const change: any = { active_project_tab: key };
    switch (key) {
      case "files":
        // Treat "/" as a fallback state. Re-entering the files tab should land in
        // HOME unless the user is already on a concrete filesystem path.
        const currentPathAbs = store.get("current_path_abs") ?? "/";
        const filesPathAbs =
          currentPathAbs === "/"
            ? this.getHomeDirectoryForPaths()
            : currentPathAbs;
        if (filesPathAbs !== currentPathAbs) {
          this.set_current_path(filesPathAbs);
        }
        if (opts.change_history) {
          this.set_url_to_path(filesPathAbs, "");
        }
        if (filesPathAbs === "/") {
          void this.resolveConcreteHomeDirectory().then((resolvedHome) => {
            const latestStore = this.get_store();
            if (
              resolvedHome !== "/" &&
              latestStore?.get("active_project_tab") === "files" &&
              latestStore.get("current_path_abs") === "/"
            ) {
              this.set_current_path(resolvedHome);
              if (opts.change_history) {
                this.set_url_to_path(resolvedHome, "");
              }
            }
          });
        }
        break;

      case "new":
        change.file_creation_error = undefined;
        if (opts.change_history) {
          this.push_state(
            this.toAuxTabPath("new", store.get("current_path_abs") ?? "/"),
            "",
          );
        }
        const new_fn = default_filename(opts.new_ext, this.project_id);
        this.set_next_default_filename(new_fn);
        break;

      case "log":
        if (opts.change_history) {
          this.push_state("log", "");
        }
        break;

      case "search":
        if (opts.change_history) {
          this.push_state(
            this.toAuxTabPath("search", store.get("current_path_abs") ?? "/"),
            "",
          );
        }
        break;

      case "servers":
        if (opts.change_history) {
          this.push_state("apps", "");
        }
        break;

      case "settings":
        if (opts.change_history) {
          this.push_state("settings", "");
        }
        break;

      case "info":
        if (opts.change_history) {
          this.push_state("info", "");
        }
        break;

      case "home":
        this.set_current_path(this.getHomeDirectoryForPaths());
        if (opts.change_history) {
          this.push_state("project-home", "");
        }
        break;

      case "users":
        if (opts.change_history) {
          this.push_state("users", "");
        }
        break;

      case "agents":
        if (opts.change_history) {
          this.push_state("agents", "");
        }
        break;

      case "workspaces":
        if (opts.change_history) {
          this.push_state("workspaces", "");
        }
        break;

      case "upgrades":
        if (opts.change_history) {
          this.push_state("upgrades", "");
        }
        break;

      default:
        // editor...
        const path = misc.tab_to_path(key);
        if (path == null) {
          throw Error(`must be an editor path but is ${key}`);
        }
        this.redux
          .getActions("document_activity")
          ?.mark_file(this.project_id, path, "open");
        if (opts.change_history) {
          this.push_state(this.toUrlPath(path, false));
        }
        const fileDir = misc.path_split(path).head;
        this.set_current_path(fileDir);

        const info = store.get("open_files").getIn([path, "component"]) as any;
        if (info == null) {
          // shouldn't happen...
          return;
        }
        this.ensureOpenFileComponent(path, { noFocus: opts.noFocus });
    }
    this.setState(change);
  };

  public toggleFlyout(name: FixedTab): void {
    const store = this.get_store();
    if (store == undefined) return;
    const flyout = name === store.get("flyout") ? null : name;
    this.setState({ flyout });
    // also store this in local storage
    storeFlyoutState(this.project_id, name, { expanded: flyout != null });
    if (flyout != null) {
      track("flyout", { name: flyout, project_id: this.project_id });
    }
  }

  public setFlyoutExpanded(name: FixedTab, state: boolean, save = true): void {
    this.setState({ flyout: state ? name : null });
    // also store this in local storage
    if (save) {
      storeFlyoutState(this.project_id, name, { expanded: name != null });
    }
  }

  public setFlyoutLogMode(mode: FlyoutLogMode): void {
    this.setState({ flyout_log_mode: mode });
    storeFlyoutState(this.project_id, "log", { mode });
  }

  public setFlyoutLogDeduplicate(deduplicate: FlyoutLogDeduplicate): void {
    this.setState({ flyout_log_deduplicate: deduplicate });
    storeFlyoutState(this.project_id, "log", { deduplicate });
  }

  public setFlyoutLogFilter(filter: FlyoutLogFilter, state: boolean): void {
    const store = this.get_store();
    if (store == undefined) return;
    const current: string[] =
      store.get("flyout_log_filter")?.toJS() ?? FLYOUT_LOG_FILTER_DEFAULT;

    // depending on state, make sure the filter is either in the list or not
    const next = (
      state ? [...current, filter] : current.filter((f) => f !== filter)
    ) as FlyoutLogFilter[];

    this.setState({ flyout_log_filter: List(next) });
    storeFlyoutState(this.project_id, "log", { logFilter: next });
  }

  public resetFlyoutLogFilter(): void {
    this.setState({ flyout_log_filter: List(FLYOUT_LOG_FILTER_DEFAULT) });
    storeFlyoutState(this.project_id, "log", {
      logFilter: [...FLYOUT_LOG_FILTER_DEFAULT],
    });
  }

  public setFlyoutActiveMode(mode: FlyoutActiveMode): void {
    this.setState({ flyout_active_mode: mode });
    storeFlyoutState(this.project_id, "active", { active: mode });
  }

  set_next_default_filename(next): void {
    this.setState({ default_filename: next });
  }

  async set_activity(opts): Promise<void> {
    opts = defaults(opts, {
      id: required, // client must specify this, e.g., id=misc.uuid()
      status: undefined, // status update message during the activity -- description of progress
      stop: undefined, // activity is done  -- can pass a final status message in.
      error: undefined, // describe an error that happened
    });
    const store = this.get_store();
    if (store == undefined) {
      return;
    }

    // If there is activity it's also a good opportunity to
    // express that we are interested in this project.
    this.touch();

    let x =
      store.get("activity") != null ? store.get("activity").toJS() : undefined;
    if (x == null) {
      x = {};
    }
    // Actual implementation of above specified API is VERY minimal for
    // now -- just enough to display something to user.
    if (opts.status != null) {
      x[opts.id] = opts.status;
      this.setState({ activity: x });
    }
    if (opts.error != null) {
      const { error } = opts;
      if (error === "") {
        this.setState({ error });
      } else {
        this.setState({
          error: (
            (store.get("error") != null ? store.get("error") : "") +
            "\n" +
            error
          ).trim(),
        });
      }
    }
    if (opts.stop != null) {
      if (opts.stop) {
        x[opts.id] = opts.stop; // of course, just gets deleted below but that is because use is simple still
      }
      delete x[opts.id];
      this.setState({ activity: x });
    }
  }

  /**
   *
   * Report a log event to the backend -- will indirectly result in a new entry in the store...
   * Allows for updating logs via merging if `id` is provided
   *
   * Returns the random log entry uuid. If called later with that id, then the time isn't
   * changed and the event is merely updated.
   * Returns undefined if log event is ignored
   */
  // NOTE: we can't just make this log function async since it returns
  // an id that we use later to update the log, and we would have
  // to change whatever client code uses that id to be async.  Maybe later.
  // So we make the new function async_log below.
  log(event: ProjectEvent): string | undefined;
  log(
    event: Partial<ProjectEvent>,
    id: string,
    cb?: (err?: any) => void,
  ): string | undefined;
  log(event: ProjectEvent, id?: string, cb?: Function): string | undefined {
    const my_role = (this.redux.getStore("projects") as any).get_my_group(
      this.project_id,
    );
    if (["public", "admin"].indexOf(my_role) != -1) {
      // Ignore log events for *both* admin and public.
      // Admin gets to be secretive (also their account_id --> name likely wouldn't be known to users).
      // Public users don't log anything.
      if (cb != null) cb();
      return; // ignore log events
    }
    const obj: any = {
      event,
      project_id: this.project_id,
    };
    if (!id) {
      // new log entry
      id = misc.uuid();
      obj.time = misc.server_time();
    }
    obj.id = id;
    const row: ProjectLogRow = {
      id: obj.id,
      project_id: this.project_id,
      account_id: webapp_client.account_id,
      time: obj.time,
      event: obj.event,
    };
    this.getProjectLogStream()
      .then(async (stream) => {
        stream.publish(row);
        await stream.save();
      })
      .then(() => cb?.())
      .catch((err) => {
        if (err) {
          // TODO: what do we want to do if a log doesn't get recorded?
          // (It *should* keep trying and store that in localStorage, and try next time, etc...
          //  of course done in a systematic way across everything.)
          console.warn("error recording a log entry: ", err, event);
        }
        cb?.(err);
      });

    if (window.parent != null) {
      // (I think this is always defined.)
      // We also fire a postMessage.  This allows the containing
      // iframe (if there is one), or other parts of the page, to
      // be alerted of any logged event, which can be very helpful
      // when building applications.  See
      //      https://github.com/sagemathinc/cocalc/issues/4145
      // If embedded in an iframe, it is the embedding window.
      // If not in an iframe, seems to be the window itself.
      // I copied the {source:?,payload:?} format from react devtools.
      window.parent.postMessage(
        { source: "cocalc-project-log", payload: { project_log: obj } },
        "*",
      );
    }

    return id;
  }

  public async async_log(event: ProjectEvent, id?: string): Promise<void> {
    await callback(this.log.bind(this), event, id);
  }

  public log_opened_time(path): void {
    log_opened_time(this.project_id, path);
  }

  // Save the given file in this project (if it is open) to disk.
  save_file(opts): void {
    opts = defaults(opts, { path: required });
    if (
      (!this.redux.getStore("projects") as any).is_project_open(this.project_id)
    ) {
      return; // nothing to do regarding save, since project isn't even open
    }
    // NOTE: someday we could have a non-public relationship to project, but still open an individual file in public mode
    const store = this.get_store();
    if (store == undefined) {
      return;
    }

    project_file.save(opts.path, this.redux, this.project_id);
  }

  // Save all open files in this project
  save_all_files(): void {
    const s: any = this.redux.getStore("projects");
    if (!s.is_project_open(this.project_id)) {
      return; // nothing to do regarding save, since project isn't even open
    }
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    store.get("open_files").forEach((val, path) => {
      const component = val.get("component");
      if (component == null) {
        // This happens, e.g., if you have a tab for a file,
        // but it hasn't been focused, so there's no actual
        // information to save (basically a background tab
        // that has not yet been initialized).
        return;
      }
      project_file.save(path, this.redux, this.project_id);
    });
  }

  public open_in_new_browser_window(path: string, fullscreen = "kiosk"): void {
    let url = join(
      appBasePath,
      this._url_in_project(this.toUrlPath(path, false)),
    );
    url += "?session=";
    if (fullscreen) {
      url += `&fullscreen=${fullscreen}`;
    }
    const width = Math.round(window.screen.width * 0.75);
    const height = Math.round(window.screen.height * 0.75);
    open_popup_window(url, { width, height });
  }

  public async open_word_document(path): Promise<void> {
    // Microsoft Word Document
    alert_message({
      type: "info",
      message: `Opening converted plain text file instead of '${path}...`,
    });
    try {
      const converted: string = await this.convert_docx_file(path);
      await this.open_file({
        path: converted,
        foreground: true,
        foreground_project: true,
      });
    } catch (err) {
      alert_message({
        type: "error",
        message: `Error converting Microsoft docx file -- ${err}`,
      });
    }
  }

  // Open the given file in this project.
  open_file = async (opts: OpenFileOpts): Promise<void> => {
    // Log that we *started* opening the file.
    log_file_open(this.project_id, opts.path);
    if (this.state == "closed") return;
    await open_file(this, opts);
  };

  /* Initialize the redux store and react component for editing
     a particular file, if necessary.
  */
  initFileRedux = reuseInFlight(
    async (
      path: string,
      ext?: string, // use this extension even instead of path's extension.
    ): Promise<string | undefined> => {
      const cur = redux.getEditorActions(this.project_id, path);
      if (cur != null) {
        return cur.name;
      }
      const staleName = redux_name(this.project_id, path);
      const staleActions: any = redux.getActions(staleName);
      if (
        staleActions != null &&
        typeof staleActions.isClosed === "function" &&
        staleActions.isClosed()
      ) {
        redux.removeActions(staleName);
        redux.removeStore(staleName);
      }
      // LAZY IMPORT, so that editors are only available
      // when you are going to use them.  Helps with code splitting.
      await import("../../editors/register-all");

      // Initialize the file's store and actions
      const name = await project_file.initializeAsync(
        path,
        this.redux,
        this.project_id,
        undefined,
        ext,
      );
      return name;
    },
  );

  private init_file_react_redux = async (
    path: string,
    ext?: string,
  ): Promise<{ name: string | undefined; Editor: any }> => {
    const name = await this.initFileRedux(path, ext);

    // Make the Editor react component
    const Editor = await project_file.generateAsync(
      path,
      this.redux,
      this.project_id,
      ext,
    );

    return { name, Editor };
  };

  private ensureOpenFileComponent = (
    path: string,
    opts: { noFocus?: boolean } = {},
  ): void => {
    const info = this.get_store()
      ?.get("open_files")
      .getIn([path, "component"]) as any | undefined;
    if (info == null) {
      return;
    }
    if (info.redux_name != null && info.Editor != null) {
      if (!opts.noFocus) {
        this.show_file(path);
      }
      return;
    }
    if (this.open_files == null) return;
    void (async () => {
      try {
        const syncPath = this.get_sync_path(path);
        const { name, Editor } = await this.init_file_react_redux(
          syncPath,
          this.open_files?.get(path, "ext"),
        );
        const current_info = this.get_store()
          ?.get("open_files")
          .getIn([path, "component"]) as any;
        if (this.open_files == null || current_info == null) return;
        current_info.redux_name = name;
        current_info.Editor = Editor;
        this.open_files.set(path, "component", { ...current_info });
        if (!opts.noFocus) {
          this.show_file(path);
        }
        const fragmentId = this.get_store()
          ?.get("open_files")
          .getIn([path, "fragmentId"]) as any;
        if (fragmentId) {
          this.gotoFragment(path, fragmentId);
        }
        if (this.open_files.get(path, "chatState") == "pending") {
          this.open_chat({ path });
        }
      } catch (err) {
        const current_info = this.get_store()
          ?.get("open_files")
          .getIn([path, "component"]) as any;
        if (this.open_files == null || current_info == null) return;
        const error = err as Error;
        current_info.Editor = () =>
          require("react").createElement(EditorLoadError, {
            path,
            error,
          });
        this.open_files.set(path, "component", { ...current_info });
        if (!opts.noFocus) {
          this.show_file(path);
        }
        console.debug(
          `Editor initialization failed for ${path}, error already shown to user`,
        );
      }
    })();
  };

  public ensure_open_file_component = (
    path: string,
    opts: { noFocus?: boolean } = {},
  ): void => {
    this.ensureOpenFileComponent(path, opts);
  };

  private get_sync_path(path: string): string {
    const homeDirectory = this.getHomeDirectoryForPaths();
    const sync_path = this.open_files?.get(path, "sync_path");
    if (typeof sync_path === "string" && sync_path.length > 0) {
      // Backward-compat: old sessions may persist ipynb tabs with sync_path
      // set to .<name>.ipynb.sage-jupyter2. For editor actions/state, notebooks
      // must be keyed by the user-visible .ipynb path.
      if (
        misc.filename_extension(path).toLowerCase() === "ipynb" &&
        isJupyterPath(sync_path)
      ) {
        const canonicalPath = canonicalSyncPath(path, homeDirectory);
        if (
          this.open_files != null &&
          this.open_files.get(path, "sync_path") !== canonicalPath
        ) {
          this.open_files.set(path, "sync_path", canonicalPath);
        }
        return canonicalPath;
      }
      const canonicalPath = canonicalSyncPath(sync_path, homeDirectory);
      if (
        this.open_files != null &&
        this.open_files.get(path, "sync_path") !== canonicalPath
      ) {
        this.open_files.set(path, "sync_path", canonicalPath);
      }
      return canonicalPath;
    }
    const canonicalPath = canonicalSyncPath(path, homeDirectory);
    if (
      this.open_files != null &&
      this.open_files.get(path, "sync_path") !== canonicalPath
    ) {
      this.open_files.set(path, "sync_path", canonicalPath);
    }
    return canonicalPath;
  }

  private has_display_path_for_sync_path(
    sync_path: string,
    except_path?: string,
  ): boolean {
    const homeDirectory = this.getHomeDirectoryForPaths();
    const canonicalSync = canonicalSyncPath(sync_path, homeDirectory);
    const store = this.get_store();
    const open_files = store?.get("open_files");
    if (open_files == null) {
      return false;
    }
    let found = false;
    open_files.forEach((_obj, display_path) => {
      if (found || display_path === except_path) {
        return;
      }
      const other_sync_path = open_files.getIn([display_path, "sync_path"]);
      if (typeof other_sync_path === "string") {
        if (
          canonicalSyncPath(other_sync_path, homeDirectory) === canonicalSync
        ) {
          found = true;
        }
      } else if (
        canonicalSyncPath(display_path, homeDirectory) === canonicalSync
      ) {
        // Backward-compatible fallback for tabs opened before sync_path existed.
        found = true;
      }
    });
    return found;
  }

  get_scroll_saver_for = (path: string) => {
    if (path != null) {
      return (scroll_position) => {
        const store = this.get_store();
        if (
          // Ensure prerequisite things exist
          store == undefined ||
          store.get("open_files") == undefined ||
          store.get("open_files").getIn([path, "component"]) == undefined
        ) {
          return;
        }
        // WARNING: Saving scroll position does NOT trigger a rerender. This is intentional.
        const info = store!.get("open_files").getIn([path, "component"]) as any;
        info.scroll_position = scroll_position; // Yes, this mutates the store silently.
        return scroll_position;
      };
    }
  };

  // Moves to the given fragment if the gotoFragment action is implemented and accepted,
  // and the file actions exist already (e.g. file was opened).
  // Otherwise, silently does nothing.  Has a fallback for now for fragmentId='line=[number]'.
  public gotoFragment(path: string, fragmentId: FragmentId): void {
    // console.log("gotoFragment", { path, fragmentId });
    if (typeof fragmentId != "object") {
      console.warn(`gotoFragment -- invalid fragmentId: "${fragmentId}"`);
      return;
    }
    const sync_path = this.get_sync_path(path);
    const actions: any = redux.getEditorActions(this.project_id, sync_path);
    const store = this.get_store();
    // We ONLY actually goto the fragment if the file is the active one
    // in the active project and the actions for that file have been created.
    // Otherwise, we just save the fragment for later when the file is opened
    // and this.show_file gets called, thus triggering all this again.
    if (
      actions != null &&
      store != null &&
      path == misc.tab_to_path(store.get("active_project_tab")) &&
      this.isProjectTabVisible()
    ) {
      // Clear the fragmentId from the "todo" state, so we won't try to use
      // this next time we display the file:
      this.open_files?.set(path, "fragmentId", undefined);
      // The file is actually visible, so we can try to scroll to the fragment.
      // set the fragment in the URL if the file is in the foreground
      Fragment.set(fragmentId);
      if (actions.gotoFragment != null) {
        actions.gotoFragment(fragmentId);
        return;
      }
      // a fallback for now.
      if (fragmentId.line != null) {
        this.goto_line(path, fragmentId.line, true, true);
        return;
      }
    } else {
      // File is NOT currently visible, so going to the fragment is likely
      // to break for many editors.  e.g., codemirror background editor just
      // does nothing since it has no DOM measurements...
      // Instead we record the fragment we want to be at, and when the
      // tab is next shown, it will move there.
      this.open_files?.set(path, "fragmentId", fragmentId);
    }
  }

  // Returns true if this project is the currently selected top nav.
  public isProjectTabVisible(): boolean {
    return this.redux.getStore("page").get("active_top_tab") == this.project_id;
  }

  // If the given path is open, and editor supports going to line,
  // moves to the given line.  Otherwise, does nothing.
  public goto_line(path, line, cursor?: boolean, focus?: boolean): void {
    const sync_path = this.get_sync_path(path);
    const actions: any = redux.getEditorActions(this.project_id, sync_path);
    actions?.programmatical_goto_line?.(line, cursor, focus);
  }

  // Called when a file tab is shown.
  private show_file(path): void {
    const sync_path = this.get_sync_path(path);
    const a: any = redux.getEditorActions(this.project_id, sync_path);
    a?.show?.();
    const fragmentId = this.open_files?.get(path, "fragmentId");
    if (fragmentId) {
      // have to wait for next render so that local store is updated and
      // also any rendering and measurement happens with the editor.
      setTimeout(() => {
        this.gotoFragment(path, fragmentId);
      }, 0);
    }
  }

  // Called when a file tab is put in the background due to
  // another tab being made active.
  private hide_file(path): void {
    const sync_path = this.get_sync_path(path);
    const a: any = redux.getEditorActions(this.project_id, sync_path);
    if (typeof a?.hide === "function") {
      a.hide();
    }
  }

  // Used by open/close chat below.
  set_chat_state(path: string, chatState: ChatState): void {
    if (this.open_files == null) {
      return;
    }
    this.open_files.set(path, "chatState", chatState);
    local_storage(this.project_id, path, "chatState", chatState);
  }

  // Open side chat for the given file, assuming the file is open, store is initialized, etc.
  open_chat = ({ path, width = 0.7 }: { path: string; width?: number }) => {
    const info = this.get_store()
      ?.get("open_files")
      .getIn([path, "component"]) as any;
    if (info?.Editor == null) {
      // not opened in the foreground yet.
      this.set_chat_state(path, "pending");
      return;
    }
    //  not null for modern editors.
    const sync_path = this.get_sync_path(path);
    const editorActions = redux.getEditorActions(this.project_id, sync_path);
    if (editorActions?.["show_focused_frame_of_type"] != null) {
      // @ts-ignore -- todo will go away when everything is a frame editor
      editorActions.show_focused_frame_of_type("chat", "col", false, width);
      this.set_chat_state(path, "internal");
    } else {
      // First create the chat actions:
      initChat(this.project_id, misc.meta_file(sync_path, "chat"));
      // Only then set state to say that the chat is opened!
      // Otherwise when the opened chat is rendered actions is
      // randomly not defined, and things break.
      this.set_chat_state(path, "external");
    }
  };

  // Close side chat for the given file, assuming the file itself is open
  // NOTE: for frame tree if there are no chat frames, this instead opens
  // a chat frame.
  close_chat({ path }: { path: string }): void {
    const sync_path = this.get_sync_path(path);
    const editorActions = redux.getEditorActions(this.project_id, sync_path);
    if (editorActions?.["close_recently_focused_frame_of_type"] != null) {
      let n = 0;
      // @ts-ignore -- todo will go away when everything is a frame editor
      while (editorActions.close_recently_focused_frame_of_type("chat")) {
        n += 1;
      }
      if (n == 0) {
        // nothing actually closed - so we open
        // TODO: This is just a workaround until we only use frame editors.
        this.open_chat({ path });
        return;
      }
      this.set_chat_state(path, "");
    } else {
      removeChatRuntime(
        misc.meta_file(sync_path, "chat"),
        this.redux,
        this.project_id,
      );
      this.set_chat_state(path, "");
    }
  }

  set_chat_width(opts): void {
    opts = defaults(opts, {
      path: required,
      width: required,
    }); // between 0 and 1
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const open_files = store.get("open_files");
    if (open_files != null) {
      if (this.open_files == null) return;
      const width = misc.ensure_bound(opts.width, 0.05, 0.95);
      local_storage(this.project_id, opts.path, "chat_width", width);
      this.open_files.set(opts.path, "chat_width", width);
    }
  }

  // OPTIMIZATION: Some possible performance problems here. Debounce may be necessary
  flag_file_activity(filename: string): void {
    if (this.open_files == null) return;
    if (filename == null || !this.open_files.has(filename)) {
      // filename invalid or not currently open, see
      //  https://github.com/sagemathinc/cocalc/issues/4717
      return;
    }

    const timer = this._activity_indicator_timers[filename];
    if (timer != null) {
      window.clearTimeout(timer);
    }

    const set_inactive = () => {
      if (!this.open_files?.has(filename)) return;
      this.open_files.set(filename, "has_activity", false);
    };

    this._activity_indicator_timers[filename] = window.setTimeout(
      set_inactive,
      1000,
    );

    this.open_files.set(filename, "has_activity", true);
    this.touchActiveFileIfOnComputeServer(filename);
  }

  private touchActiveFileIfOnComputeServer = throttle(async (_path: string) => {
    void _path;
    return;
  }, 15000);

  private async convert_docx_file(filename): Promise<string> {
    const conf = await this.init_configuration("main");
    if (conf != null && conf.capabilities.pandoc === false) {
      throw new Error(
        "Pandoc not installed – unable to convert docx to markdown.",
      );
    }
    const md_fn = misc.change_filename_extension(filename, "md");
    // pandoc -s example30.docx -t gfm [or markdown] -o example35.md
    await webapp_client.project_client.exec({
      project_id: this.project_id,
      command: "pandoc",
      args: ["-s", filename, "-t", "gfm", "-o", md_fn],
    });
    return md_fn;
  }

  // Closes all files and removes all references
  close_all_files() {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const file_paths = store.get("open_files");
    const removed_sync_paths = new Set<string>();
    file_paths.map((_obj, path) => {
      const sync_path = this.get_sync_path(path);
      if (removed_sync_paths.has(sync_path)) {
        return;
      }
      removed_sync_paths.add(sync_path);
      project_file.remove(sync_path, this.redux, this.project_id);
      removeChatRuntime(
        misc.meta_file(sync_path, "chat"),
        this.redux,
        this.project_id,
      );
    });

    this.open_files?.close_all();
  }

  // Closes the file and removes all references.
  // Does not update tabs
  close_file = (path: string): void => {
    path = normalize(path);
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const open_files = store.get("open_files");
    // Close any tracked open-file row, even if component bootstrap never completed.
    // Some failure paths leave entries without `component`, and requiring it here
    // makes those tabs impossible to close/reopen.
    if (open_files?.get(path) == null) return;
    const sync_path = this.get_sync_path(path);
    this.open_files?.delete(path);
    if (!this.has_display_path_for_sync_path(sync_path, path)) {
      project_file.remove(sync_path, this.redux, this.project_id);
      removeChatRuntime(
        misc.meta_file(sync_path, "chat"),
        this.redux,
        this.project_id,
      );
    }
    this.save_session();
  };

  // Makes this project the active project tab
  foreground_project = async (change_history = true) => {
    try {
      await this.ensureProjectIsOpen();
    } catch (err) {
      console.warn(
        "error putting project in the foreground: ",
        err,
        this.project_id,
      );
      return;
    }
    this.redux
      .getActions("projects")
      .foreground_project(this.project_id, change_history);
  };

  open_directory = async (
    path,
    change_history = true,
    show_files = true,
    foreground_project = true,
  ) => {
    path = normalize(path);
    // Be forgiving if a route-like path is passed here.
    if (path === "files") {
      path = this.getHomeDirectoryForPaths();
    } else if (path.startsWith("files/")) {
      const rel = path.replace(/^files\/+/, "");
      path = rel.length === 0 ? this.getHomeDirectoryForPaths() : `/${rel}`;
    }
    try {
      await this.ensureProjectIsOpen(foreground_project);
    } catch (err) {
      console.warn(
        "error opening directory in project: ",
        err,
        this.project_id,
        path,
      );
      return;
    }
    if (path !== "/" && path[path.length - 1] === "/") {
      path = path.slice(0, -1);
    }
    const nextPathAbs = this.toAbsoluteCurrentPath(path);
    if (foreground_project) {
      this.foreground_project(change_history);
    }
    this.set_current_path(nextPathAbs);
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    if (show_files) {
      this.set_active_tab("files", {
        update_file_listing: false,
        change_history: false, // see "if" below
      });
    }
    if (change_history) {
      // i.e. regardless of show_files is true or false, we might want to record this in the history
      this.set_url_to_path(nextPathAbs, "");
    }
    this.set_all_files_unchecked();
  };

  // ONLY updates current path
  // Does not push to URL, browser history, or add to analytics
  // Use internally or for updating current path in background
  set_current_path = (path: string = "/"): void => {
    if (Number.isNaN(path as any)) {
      path = "/";
    }
    if (typeof path !== "string") {
      throw Error("Current path should be a string");
    }
    const pathAbs = this.toAbsoluteCurrentPath(path);
    // Set the current path for this project. path is either a string or array of segments.
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    let history_path_abs = store.get("history_path_abs") || "/";
    const is_adjacent_abs =
      pathAbs.length > 0 && !(history_path_abs + "/").startsWith(pathAbs + "/");
    const is_nested_abs = pathAbs.length > history_path_abs.length;
    if (is_adjacent_abs || is_nested_abs) {
      history_path_abs = pathAbs;
    }
    if (store.get("current_path_abs") != pathAbs) {
      this.clear_file_listing_scroll();
      this.clear_selected_file_index();
    }
    this.setState({
      current_path_abs: pathAbs,
      history_path_abs,
      most_recent_file_click: undefined,
    });
  };

  set_file_search(search): void {
    this.setState({
      file_search: search,
      file_action: undefined,
      most_recent_file_click: undefined,
      create_file_alert: false,
    });
  }

  // Increases the selected file index by 1
  // undefined increments to 0
  increment_selected_file_index(): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const selected_file_index = nextSelectedFileIndex({
      selectedFileIndex: store.get("selected_file_index"),
      numDisplayedFiles: store.get("numDisplayedFiles"),
      delta: 1,
    });
    if (selected_file_index != null) {
      this.setState({ selected_file_index });
    }
  }

  // Decreases the selected file index by 1.
  // Guaranteed to never set below 0.
  // Does nothing when selected_file_index is undefined
  decrement_selected_file_index(): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const selected_file_index = nextSelectedFileIndex({
      selectedFileIndex: store.get("selected_file_index"),
      delta: -1,
    });
    if (selected_file_index != null) {
      this.setState({ selected_file_index });
    }
  }

  zero_selected_file_index(): void {
    this.setState({ selected_file_index: 0 });
  }

  clear_selected_file_index(): void {
    this.setState({ selected_file_index: undefined });
  }

  // Set the most recently clicked checkbox, expects a full/path/name
  set_most_recent_file_click(file): void {
    this.setState({ most_recent_file_click: file });
  }

  // Set the selected state of all files between the most_recent_file_click and the given file
  set_selected_file_range(
    file: string,
    checked: boolean,
    listing,
    current_path?: string,
  ): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    const range = selectedFileRange({
      file,
      listing,
      currentPath: current_path ?? store.get("current_path_abs") ?? "/",
      mostRecentFileClick: store.get("most_recent_file_click"),
    });

    if (checked) {
      this.set_file_list_checked(range);
    } else {
      this.set_file_list_unchecked(range);
    }
  }

  // set the given file to the given checked state
  set_file_checked(file: string, checked: boolean) {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    this.setState(
      setFileCheckedState<FileAction>({
        checkedFiles: store.get("checked_files"),
        fileAction: store.get("file_action"),
        allowsMultipleFiles: (action) =>
          FILE_ACTIONS[action].allows_multiple_files,
        file,
        checked,
      }),
    );
  }

  // check all files in the given file_list
  set_file_list_checked(file_list: List<string> | string[]): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    this.setState(
      setFileListCheckedState<FileAction>({
        checkedFiles: store.get("checked_files"),
        fileAction: store.get("file_action"),
        allowsMultipleFiles: (action) =>
          FILE_ACTIONS[action].allows_multiple_files,
        fileList: file_list,
      }),
    );
  }

  // uncheck all files in the given file_list
  set_file_list_unchecked(file_list: List<string> | string[]): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    this.setState(
      setFileListUncheckedState<FileAction>({
        checkedFiles: store.get("checked_files"),
        fileList: file_list,
      }),
    );
  }

  // uncheck all files
  set_all_files_unchecked(): void {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }
    this.setState({
      checked_files: store.get("checked_files").clear(),
    });
  }

  suggestDuplicateFilenameInCurrentDirectory = (
    name: string,
  ): string | undefined => {
    const store = this.get_store();
    if (store == undefined) {
      return;
    }

    return suggestDuplicateFilenameInDirectory({
      name,
      filesInDir: this.get_filenames_in_current_dir() || {},
    });
  };

  set_file_action = (action?: FileAction): void => {
    const store = this.get_store();
    if (store == null) {
      return;
    }
    this.setState({ file_action: action });
  };

  showFileActionPanel = async ({
    path,
    action,
  }: {
    path: string;
    action:
      | FileAction
      | "open"
      | "open_recent"
      | "quit"
      | "close"
      | "new"
      | "create"
      | "upload";
  }) => {
    this.set_all_files_unchecked();
    if (action == "new" || action == "create") {
      // special case because it isn't a normal "file action panel",
      // but it is convenient to still support this.
      if (this.get_store()?.get("flyout") != "new") {
        this.toggleFlyout("new");
      }
      this.setState({
        default_filename: default_filename(
          misc.filename_extension(path),
          this.project_id,
        ),
      });
      return;
    }
    if (action == "upload") {
      this.set_active_tab("files");
      setTimeout(() => {
        // NOTE: I'm not proud of this, but right now our upload functionality
        // is based on not-very-react-ish library...
        $(".upload-button").click();
      }, 100);
      return;
    }
    if (action == "open") {
      if (this.get_store()?.get("flyout") != "files") {
        this.toggleFlyout("files");
      }
      return;
    }
    if (action == "open_recent") {
      if (this.get_store()?.get("flyout") != "log") {
        this.toggleFlyout("log");
      }
      return;
    }

    const path_splitted = misc.path_split(path);
    await this.open_directory(path_splitted.head);

    if (action == "quit") {
      // TODO: for jupyter and terminal at least, should also do more!
      this.close_tab(path);
      return;
    }
    if (action == "close") {
      this.close_tab(path);
      return;
    }
    this.set_file_checked(path, true);
    this.set_file_action(action);
  };

  showFileActionPanelForPaths = async ({
    paths,
    action,
  }: {
    paths: string[];
    action: FileAction;
  }) => {
    const uniquePaths = uniqueFileActionPaths(paths);
    if (uniquePaths.length === 0) {
      return;
    }
    if (uniquePaths.length === 1) {
      await this.showFileActionPanel({ path: uniquePaths[0], action });
      return;
    }

    this.set_all_files_unchecked();
    await this.open_directory(misc.path_split(uniquePaths[0]).head);
    this.set_file_list_checked(uniquePaths);
    this.set_file_action(action);
  };

  private async get_from_web(opts: {
    url: string;
    dest?: string;
    timeout: number;
    alert?: boolean;
  }): Promise<void> {
    opts = defaults(opts, {
      url: required,
      dest: undefined,
      timeout: 45,
      alert: true,
    });

    const { command, args } = transform_get_url(opts.url);

    try {
      await webapp_client.project_client.exec({
        project_id: this.project_id,
        command,
        timeout: opts.timeout,
        path: opts.dest,
        args,
      });
    } catch (err) {
      alert_message({ type: "error", message: err, timeout: 15 });
    }
  }

  private appendSlashToDirectoryPaths = async (
    paths: string[],
  ): Promise<string[]> => {
    const f = async (path: string) => {
      if (path.endsWith("/")) {
        return path;
      }
      const isDir = this.isDirViaCache(path);
      if (isDir === false) {
        return path;
      }
      if (isDir === true) {
        return path + "/";
      }
      if (await this.isDir(path)) {
        return path + "/";
      } else {
        return path;
      }
    };
    return await Promise.all(paths.map(f));
  };

  // this is called in "projects.cjsx" (more then once)
  // in turn, it is calling init methods just once, though
  init(): void {
    if (this._init_done) {
      // console.warn("ProjectActions::init called more than once");
      return;
    }
    this._init_done = true;
    // initialize project configuration data
    this.init_configuration();
    this.init_runstate_watcher();
  }

  // listen on certain runstate events and trigger associated actions
  // this method should only be called once
  private init_runstate_watcher(): void {
    const store = this.get_store();
    if (store == null) return;

    store.on("started", () => {
      this.reload_configuration();
    });

    store.on("stopped", () => {
      this.clear_configuration();
    });
  }

  // invalidates configuration cache
  private clear_configuration(): void {
    this.setState({
      configuration: undefined,
      available_features: undefined,
    });
  }

  reload_configuration(): void {
    this.init_configuration("main", true);
  }

  // retrieve project configuration (capabilities, etc.) from the back-end
  // also return it as a convenience
  init_configuration = reuseInFlight(
    async (
      aspect: ConfigurationAspect = "main",
      no_cache = false,
    ): Promise<Configuration | void> => {
      this.setState({ configuration_loading: true });

      const store = this.get_store();
      if (store == null) {
        // console.warn("project_actions::init_configuration: no store");
        this.setState({ configuration_loading: false });
        return;
      }

      const prev = store.get("configuration") as ProjectConfiguration;
      if (!no_cache) {
        // already done before?
        if (prev != null) {
          const conf = prev.get(aspect) as Configuration;
          if (conf != null) {
            this.setState({ configuration_loading: false });
            return conf;
          }
        }
      }

      // we do not know the configuration aspect. "next" will be the updated datastructure.
      let next;

      await retry_until_success({
        f: async () => {
          try {
            next = await get_configuration(
              webapp_client,
              this.project_id,
              aspect,
              prev,
              no_cache,
            );
          } catch (e) {
            // not implemented error happens, when the project is still the old one
            // in that case, do as if everything is available
            if (e.message.indexOf("not implemented") >= 0) {
              return null;
            }
            //             console.log(
            //               `WARNING -- project_actions::init_configuration err: ${e}`,
            //             );
            throw e;
          }
        },
        start_delay: 2000,
        max_delay: 5000,
        desc: "project_actions::init_configuration",
      });

      // there was a problem or configuration is not known
      if (next == null) {
        this.setState({ configuration_loading: false });
        return;
      }

      const previousHomeDirectory = this.getHomeDirectoryForPaths();

      this.setState(
        fromJS({
          configuration: next,
          available_features: feature_is_available(next),
          configuration_loading: false,
        } as any),
      );

      const homeDirectory = (next.get("main") as any)?.capabilities
        ?.homeDirectory;
      if (typeof homeDirectory === "string" && homeDirectory.length > 0) {
        const normalizedHomeDirectory = normalizeAbsolutePath(homeDirectory);
        if (previousHomeDirectory === "/" && normalizedHomeDirectory !== "/") {
          this.replaceFallbackRootWithHome(normalizedHomeDirectory);
        }

        // Keep project-home aligned with HOME once capabilities arrive.
        if (store.get("active_project_tab") === "home") {
          this.set_current_path(normalizedHomeDirectory);
        }
      }

      return next.get(aspect) as Configuration;
    },
  );

  copyPaths = async ({
    src,
    dest,
    id,
    only_contents,
  }: {
    src: string[];
    dest: string;
    id?: string;
    only_contents?: boolean;
  }) => {
    await copyPaths({
      src,
      dest,
      id,
      only_contents,
      fs: () => this.fs(),
      setActivity: (opts) => this.set_activity(opts),
      log: (event) => this.log(event),
      appendSlashToDirectoryPaths: this.appendSlashToDirectoryPaths,
    });
  };

  // Copy 1 or more paths from one project to another (possibly the same) project.
  copyPathBetweenProjects = async (opts: {
    src: { project_id: string; path: string | string[] };
    src_home?: string;
    dest: { project_id: string; path: string };
    options?: CopyOptions;
  }) => {
    await copyPathBetweenProjects({
      opts,
      projectId: this.project_id,
      copyOpsTrack: (op) => this.copyOpsManager.track(op),
      appendSlashToDirectoryPaths: this.appendSlashToDirectoryPaths,
      setActivity: (activity) => this.set_activity(activity),
      log: (event) => this.log(event),
    });
  };

  renameFile = async ({
    src,
    dest,
  }: {
    src: string;
    dest: string;
  }): Promise<void> => {
    await renameFile({
      src,
      dest,
      fs: () => this.fs(),
      isDir: (path) => this.isDir(path),
      setActivity: (opts) => this.set_activity(opts),
      log: (event) => this.log(event),
    });
  };

  // note: there is no need to explicitly close or await what is returned by
  // fs(...) since it's just a lightweight wrapper object to format appropriate RPC calls.
  private filesystem?: FilesystemClient;
  private filesystemPromise?: Promise<FilesystemClient>;
  clearFilesystemClient = () => {
    this.filesystem = undefined;
    this.filesystemPromise = undefined;
  };

  resetProjectHostRuntime = () => {
    this.clearFilesystemClient();
    disconnect_from_project(this.project_id);
    this.projectStatusSub?.close();
    delete this.projectStatusSub;
    const store = this.get_store();
    const hasProjectLogLoaded = store?.get("project_log") != null;
    void resetOpenFileRuntimeAfterHostReset({
      openFiles: store?.get("open_files"),
      activeProjectTab: store?.get("active_project_tab"),
      getSyncPath: (path) => this.get_sync_path(path),
      getComponent: (path) => this.open_files?.get(path, "component"),
      setComponent: (path, component) =>
        this.open_files?.set(path, "component", component),
      removeRuntime: async (syncPath) => {
        await project_file.remove(syncPath, this.redux, this.project_id);
      },
      rebootstrapPath: async (path, opts) => {
        this.ensureOpenFileComponent(path, opts);
      },
    });
    void (async () => {
      await this.resetProjectLogStream();
      if (hasProjectLogLoaded) {
        await this.load_project_log("newer");
      }
    })();
    if (this.initialized) {
      this.initProjectStatus();
    }
  };

  recoverOpenFileRuntimeAfterUnexpectedSyncdocClose = reuseInFlight(
    async (syncPath: string): Promise<boolean> => {
      const store = this.get_store();
      const canonicalSyncPathValue = this.get_sync_path(syncPath);
      const matchingOpenFiles = selectOpenFilesForSyncPath({
        openFiles: store?.get("open_files"),
        targetSyncPath: canonicalSyncPathValue,
        getSyncPath: (path) => this.get_sync_path(path),
      });
      if (matchingOpenFiles.size === 0) {
        return false;
      }
      await resetOpenFileRuntimeAfterHostReset({
        openFiles: matchingOpenFiles,
        activeProjectTab: store?.get("active_project_tab"),
        getSyncPath: (path) => this.get_sync_path(path),
        getComponent: (path) => this.open_files?.get(path, "component"),
        setComponent: (path, component) =>
          this.open_files?.set(path, "component", component),
        removeRuntime: async (path) => {
          await project_file.remove(path, this.redux, this.project_id);
        },
        rebootstrapPath: async (path, opts) => {
          this.ensureOpenFileComponent(path, opts);
        },
      });
      return true;
    },
  );

  private getFilesystemClient = async (
    forceRefresh: boolean = false,
  ): Promise<FilesystemClient> => {
    if (forceRefresh) {
      this.clearFilesystemClient();
    }
    this.filesystemPromise ??= webapp_client.conat_client.projectFs({
      project_id: this.project_id,
      caller: "ProjectActions.fs",
    });
    return await this.filesystemPromise;
  };

  fs = (): FilesystemClient => {
    this.filesystem ??= new Proxy(
      {},
      {
        get: (_target, prop) => {
          return async (...args) => {
            return await callFilesystemClientWithRecovery({
              getClient: (forceRefresh?: boolean) =>
                this.getFilesystemClient(forceRefresh),
              clearClient: this.clearFilesystemClient,
              prop,
              args,
            });
          };
        },
      },
    ) as FilesystemClient;
    return this.filesystem;
  };

  dust = async (path: string) => {
    return await dust({ project_id: this.project_id, path });
  };

  // if available in cache, this returns the filenames in the current directory,
  // which is often useful, or null if they are not known. This is sync, so it
  // can't query the backend.  (Here Files is a map from path names to data about them.)
  get_filenames_in_current_dir = (): Files | null => {
    const store = this.get_store();
    if (store == undefined) {
      return null;
    }
    const path = store.get("current_path_abs") ?? "/";
    return this.getFilesCache(path);
  };

  getCacheId = () => {
    return getCacheId({
      project_id: this.project_id,
    });
  };

  private getFilesCache = (path: string): Files | null => {
    if (this.isVirtualListingPath(path)) {
      return getFiles({
        cacheId: this.getCacheId(),
        path: path.replace(/^\/+/, ""),
      });
    }
    const normalizedPath =
      path === "" || path === "." ? "/" : normalizeAbsolutePath(path);
    return getFiles({
      cacheId: this.getCacheId(),
      path: normalizedPath,
    });
  };

  // using listings cache, attempt to tell if path is a directory;
  // undefined if no data about path in the cache.
  isDirViaCache = (path: string): boolean | undefined => {
    if (
      !path ||
      path === "." ||
      path === "/" ||
      this.isVirtualListingPath(path)
    ) {
      return true;
    }
    const { head: dir, tail: base } = misc.path_split(path);
    const files = this.getFilesCache(dir);
    const data = files?.[base];
    if (data == null) {
      return undefined;
    } else {
      return !!data.isDir;
    }
  };

  // return true if exists and is a directory
  // error if doesn't exist or can't find out.
  // Use isDirViaCache for more of a fast hint.
  isDir = async (path: string): Promise<boolean> => {
    if (
      path === "" ||
      path === "." ||
      path === "/" ||
      this.isVirtualListingPath(path)
    ) {
      return true; // easy special case
    }
    const stats = await this.fs().stat(path);
    return stats.isDirectory();
  };

  moveFiles = async ({
    src,
    dest,
  }: {
    src: string[];
    dest: string;
  }): Promise<void> => {
    await moveFiles({
      src,
      dest,
      projectId: this.project_id,
      fs: () => this.fs(),
      setActivity: (opts) => this.set_activity(opts),
      log: (event) => this.log(event),
    });
  };

  deleteFiles = async ({
    paths,
    sudo = false,
  }: {
    paths: string[];
    sudo?: boolean;
  }): Promise<void> => {
    await deleteFiles({
      paths,
      sudo,
      projectId: this.project_id,
      fs: () => this.fs(),
      setActivity: (opts) => this.set_activity(opts),
      log: (event) => this.log(event),
    });
  };

  // remove all files in the given path (or subtree of that path)
  // for which filter(filename) returns true.
  // - path should be relative to HOME
  // - filname will also be relative to HOME and will end in a slash if it is a directory
  // Returns the deleted paths.
  deleteMatchingFiles = async ({
    path,
    filter,
    recursive,
  }: {
    path: string;
    filter: (path: string) => boolean;
    recursive?: boolean;
  }): Promise<string[]> => {
    return await deleteMatchingFiles({
      path,
      filter,
      recursive,
      fs: () => this.fs(),
      deleteFiles: (opts) => this.deleteFiles(opts),
    });
  };

  download_file = async ({
    path,
    log = false,
    auto = true,
    print = false,
    showError = true,
  }: {
    path: string;
    log?: boolean | string[];
    auto?: boolean;
    print?: boolean;
    showError?: boolean;
  }): Promise<void> => {
    let url;
    if (
      !(await ensure_project_running(
        this.project_id,
        `download the file '${path}'`,
      ))
    ) {
      return;
    }

    // log could also be an array of strings to record all the files that were downloaded in a zip file
    if (log) {
      const files = Array.isArray(log) ? log : [path];
      this.log({
        event: "file_action",
        action: "downloaded",
        files,
      });
    }

    if (auto && !print) {
      const hubUrl = download_href(this.project_id, path);
      url = await webapp_client.conat_client.routeProjectHostHttpUrl({
        project_id: this.project_id,
        url: hubUrl,
      });
      try {
        await download_file(url, {
          onAuthFailure: async () => {
            await webapp_client.conat_client.ensureProjectHostBrowserSessionForProject(
              {
                project_id: this.project_id,
              },
            );
            return await webapp_client.conat_client.routeProjectHostHttpUrl({
              project_id: this.project_id,
              url: hubUrl,
            });
          },
        });
      } catch (err) {
        if (showError) {
          alert_message({
            type: "error",
            title: "Download blocked",
            message: err,
            timeout: 15,
          });
          return;
        }
        throw err;
      }
    } else {
      url = url_href(this.project_id, path);
      const tab = open_new_tab(url);
      if (tab != null && print) {
        // "?" since there might be no print method -- could depend on browser API
        tab.print?.();
      }
    }
  };

  print_file = (opts): void => {
    opts.print = true;
    this.download_file(opts);
  };

  show_upload = (show): void => {
    this.setState({ show_upload: show });
  };

  // Compute the absolute path to the file with given name but with the
  // given extension added to the file (e.g., "md") if the file doesn't have
  // that extension.  Throws an Error if the path name is invalid.
  construct_absolute_path = (
    name: string,
    current_path?: string,
    ext?: string,
  ): string => {
    const store = this.get_store();
    return constructAbsolutePath({
      name,
      currentPath: current_path ?? store?.get("current_path_abs") ?? "/",
      ext,
      toAbsoluteCurrentPath: (path) => this.toAbsoluteCurrentPath(path),
    });
  };

  createFolder = async ({
    name,
    current_path,
    switch_over = true,
  }: {
    name: string;
    current_path?: string;
    // Whether or not to switch to the new folder (default: true)
    switch_over?: boolean;
  }): Promise<void> => {
    const store = this.get_store();
    await createProjectFolder({
      name,
      currentPath: current_path ?? store?.get("current_path_abs") ?? "/",
      switch_over,
      fs: () => this.fs(),
      toAbsoluteCurrentPath: (path) => this.toAbsoluteCurrentPath(path),
      setFileCreationError: (error) =>
        this.setState({ file_creation_error: error }),
      openDirectory: (path) => this.open_directory(path),
      log: (event) => this.log(event),
    });
  };

  createFile = async ({
    name,
    ext,
    current_path,
    switch_over = true,
  }: {
    name: string;
    ext?: string;
    current_path?: string;
    switch_over?: boolean;
  }) => {
    const store = this.get_store();
    await createProjectFile({
      name,
      ext,
      currentPath: current_path ?? store?.get("current_path_abs") ?? "/",
      switch_over,
      projectId: this.project_id,
      fs: () => this.fs(),
      toAbsoluteCurrentPath: (path) => this.toAbsoluteCurrentPath(path),
      setFileCreationError: (error) =>
        this.setState({ file_creation_error: error }),
      createFolder: (opts) => this.createFolder(opts),
      newFileFromWeb: (url, currentPath) =>
        this.new_file_from_web(url, currentPath),
      ensureContainingDirectoryExists: (path) =>
        this.ensureContainingDirectoryExists(path),
      log: (event) => this.log(event),
      getPreferredKernel: () =>
        redux
          .getStore("account")
          ?.getIn(["editor_settings", "jupyter", "kernel"]),
      addCreatedTag: (tag) => redux.getActions("account")?.addTag(tag),
      openFile: (opts) => this.open_file(opts),
    });
  };

  private new_file_from_web = async (
    url: string,
    current_path: string,
  ): Promise<void> => {
    const d = current_path;
    const id = misc.uuid();
    this.setState({ downloading_file: true });
    this.set_activity({
      id,
      status: `Downloading '${url}' to '${d}', which may run for up to ${FROM_WEB_TIMEOUT_S} seconds...`,
    });
    try {
      await this.get_from_web({
        url,
        dest: current_path,
        timeout: FROM_WEB_TIMEOUT_S,
        alert: true,
      });
    } finally {
      this.set_activity({ id, stop: "" });
      this.setState({ downloading_file: false });
      this.set_active_tab("files", { update_file_listing: false });
    }
  };

  set_file_listing_scroll(scroll_top) {
    this.setState({ file_listing_scroll_top: scroll_top });
  }

  clear_file_listing_scroll() {
    this.setState({ file_listing_scroll_top: undefined });
  }

  // Loads path in this project from string
  //  files/....
  //  new
  //  log
  //  settings
  //  search
  load_target = async (
    target,
    foreground = true,
    ignore_kiosk = false,
    change_history = true,
    fragmentId?: FragmentId,
  ): Promise<void> => {
    let route = parseProjectTarget(target, {
      decodeDirectoryPath: (path) => this.fromUrlDirectoryPath(path),
    });
    if (route == null) {
      console.warn(`project/load_target: don't know segment ${target}`);
      return;
    }

    if (
      route.kind === "directory" &&
      (target === "files" || target === "files/")
    ) {
      const homeDirectory = await this.resolveConcreteHomeDirectory();
      if (homeDirectory !== "/") {
        route = { kind: "directory", path: homeDirectory };
      }
    }

    switch (route.kind) {
      case "directory":
        this.open_directory(route.path, change_history, true, foreground);
        return;

      case "file": {
        const store = this.get_store();
        if (store == null) {
          return; // project closed already
        }
        // Provisional directory context to avoid flashing "/" while stat is in flight.
        // If this turns out to be a file, use its parent directory context.
        if (this.isDirViaCache(route.path) !== false) {
          this.set_current_path(route.parentPath);
          this.set_active_tab("files", {
            update_file_listing: false,
            change_history: false,
          });
        }
        const isDir = await this.isDir(route.path);
        if (isDir) {
          this.open_directory(route.path, change_history, true, foreground);
        } else {
          this.open_file({
            path: route.path,
            foreground,
            foreground_project: foreground,
            ignore_kiosk,
            change_history,
            fragmentId,
          });
        }
        return;
      }

      case "new": // ignore foreground for these and below, since would be nonsense
        this.set_current_path(route.path);
        this.set_active_tab("new", { change_history: change_history });
        break;

      case "tab":
        if (route.tab === "project-home") {
          this.set_active_tab("home", { change_history: change_history });
          break;
        }
        this.set_active_tab(route.tab as FixedTab, {
          change_history: change_history,
        });
        break;

      case "search":
        this.set_current_path(route.path);
        this.set_active_tab("search", { change_history: change_history });
        break;

      case "app":
        if (route.path) {
          try {
            const rawUrl =
              withProjectHostBase(this.project_id, `/apps/${route.path}`) ??
              `/apps/${route.path}`;
            const authedUrl =
              await webapp_client.conat_client.addProjectHostAuthToUrl({
                project_id: this.project_id,
                url: rawUrl,
              });
            if (typeof window !== "undefined") {
              window.location.assign(authedUrl);
              return;
            }
          } catch (err) {
            console.warn("project/load_target: failed app handoff", err);
          }
        }
        this.set_active_tab("servers", { change_history: change_history });
        break;
    }
  };

  async set_environment(env: Record<string, unknown>): Promise<void> {
    if (typeof env != "object" || env == null || Array.isArray(env)) {
      throw Error("env must be an object");
    }
    const nextEnv: Record<string, string> = {};
    for (const key in env) {
      nextEnv[key] = `${env[key]}`;
    }
    await webapp_client.conat_client.hub.projects.setProjectEnv({
      project_id: this.project_id,
      env: nextEnv,
    });
    publishProjectDetailInvalidation({
      project_id: this.project_id,
      fields: ["env"],
    });
  }

  private load_project_log = reuseInFlight(
    async (mode: "initial" | "older" | "newer"): Promise<void> => {
      const store = this.get_store();
      if (store == null) return;

      const currentLog = store.get("project_log");
      const effectiveMode =
        currentLog == null || currentLog.size === 0
          ? "initial"
          : mode === "initial"
            ? "initial"
            : mode;

      if (effectiveMode === "older") {
        this.setState({
          project_log_loading_older: true,
          project_log_error: undefined,
        });
      } else {
        this.setState({
          project_log_loading: true,
          project_log_error: undefined,
        });
      }

      try {
        const rows = buildProjectLogRowsFromStream(
          await this.getProjectLogStream(),
          this.project_id,
        );
        if (effectiveMode === "newer") {
          const baseline = newestProjectLogCursor(currentLog);
          if (baseline == null) {
            return;
          }
          const merged = mergeProjectLogMap(
            currentLog,
            filterProjectLogRows(rows, { newer_than: baseline }),
          );
          this.setState({
            project_log: merged,
            project_log_loading: false,
            project_log_error: undefined,
          });
          return;
        }

        const older_than =
          effectiveMode === "older" ? oldestProjectLogCursor(currentLog) : null;
        const page = pageProjectLogRows(rows, {
          limit: PROJECT_LOG_BATCH_LIMIT,
          ...(older_than ? { older_than } : {}),
        });
        const nextLog =
          effectiveMode === "initial"
            ? buildProjectLogMap(page.entries)
            : mergeProjectLogMap(currentLog, page.entries);
        this.setState({
          project_log: nextLog,
          project_log_has_older: page.has_more,
          project_log_loading: false,
          project_log_loading_older: false,
          project_log_error: undefined,
        });
      } catch (err) {
        console.warn("project log refresh failed", {
          project_id: this.project_id,
          mode: effectiveMode,
          err,
        });
        this.setState({
          project_log_loading: false,
          project_log_loading_older: false,
          project_log_error: `${err ?? ""}`,
        });
      }
    },
    {
      createKey: ([mode]) => `${mode ?? "initial"}`,
    },
  );

  refresh_project_log = (): void => {
    void this.load_project_log("newer");
  };

  delete_project_log = async (): Promise<void> => {
    this.setState({
      project_log_deleting: true,
      project_log_error: undefined,
    });
    try {
      const stream = await this.getProjectLogStream();
      await stream.delete({ all: true });
      await this.releaseProjectLogStream?.({ immediate: true });
      if (this.projectLogStream === stream) {
        this.projectLogStream = undefined;
        this.releaseProjectLogStream = undefined;
      }
      this.setState({
        project_log: buildProjectLogMap([]),
        project_log_has_older: false,
        project_log_loading: false,
        project_log_loading_older: false,
        project_log_deleting: false,
        project_log_error: undefined,
      });
    } catch (err) {
      console.warn("project log delete failed", {
        project_id: this.project_id,
        err,
      });
      this.setState({
        project_log_deleting: false,
        project_log_error: `${err ?? ""}`,
      });
      throw err;
    }
  };

  ensure_project_log = (): void => {
    const store = this.get_store();
    if (store == null) return;
    if (store.get("project_log") != null) return;
    void this.load_project_log("initial");
  };

  project_log_load_all(): void {
    void this.load_project_log("older");
  }

  // called when project page is shown
  async show(): Promise<void> {
    const store = this.get_store();
    if (store == undefined) return; // project closed
    const a = store.get("active_project_tab");
    if (!misc.startswith(a, "editor-")) return;
    this.show_file(misc.tab_to_path(a));
  }

  // called when project page is hidden
  async hide(): Promise<void> {
    Fragment.clear();
    const store = this.get_store();
    if (store == undefined) return; // project closed
    const a = store.get("active_project_tab");
    if (!misc.startswith(a, "editor-")) return;
    this.hide_file(misc.tab_to_path(a));
  }

  ensureContainingDirectoryExists = async (path: string) => {
    await ensureProjectContainingDirectoryExists({
      path,
      ensureDirectoryExists: (path) => this.ensureDirectoryExists(path),
    });
  };

  ensureDirectoryExists = async (path: string): Promise<void> => {
    await ensureProjectDirectoryExists({
      path,
      fs: () => this.fs(),
      getFilesCache: (path) => this.getFilesCache(path),
    });
  };

  /* NOTE!  Below we store the modal state *both* in a private
  variable *and* in the store.  The reason is because we need
  to know it immediately after it is set in order for
  wait_until_no_modals to work robustless, and setState can
  wait before changing the state.
  */
  clear_modal = (): void => {
    delete this.modal;
    this.setState({ modal: undefined });
  };

  show_modal = async ({
    title,
    content,
  }: {
    title: string;
    content: string;
  }): Promise<"ok" | "cancel"> => {
    await this.wait_until_no_modals();
    let response: "ok" | "cancel" = "cancel";
    const modal = fromJS({
      title,
      content,
      onOk: () => (response = "ok"),
      onCancel: () => (response = "cancel"),
    }) as any;
    this.modal = modal;
    this.setState({ modal });
    await this.wait_until_no_modals();
    return response;
  };

  wait_until_no_modals = async (): Promise<void> => {
    const store = this.get_store();
    if (store == null) {
      return;
    }
    const noModal = () => {
      return this.modal == null && !store.get("modal");
    };

    if (noModal()) {
      return;
    }
    await store.async_wait({
      until: noModal,
      timeout: 99999,
    });
  };

  public toggleActionButtons() {
    const next = !getActivityBarCollapsed();
    setActivityBarCollapsed(next);
  }

  public clear_just_closed_files() {
    if (this.open_files != null) {
      this.open_files.set_closed_files(List([]));
      return;
    }
    this.setState({ just_closed_files: List([]) });
  }

  setServerTab = (_name: string) => {
    this.set_active_tab("new", {
      change_history: true,
    });
  };

  // time = 0 to undelete
  setRecentlyDeleted = (path: string, time: number) => {
    const store = this.get_store();
    if (store == null) return;
    let recentlyDeletedPaths = store.get("recentlyDeletedPaths") ?? Map();
    if (time == (recentlyDeletedPaths.get(path) ?? 0)) {
      // already done
      return;
    }
    recentlyDeletedPaths = recentlyDeletedPaths.set(path, time);
    this.setState({ recentlyDeletedPaths });
  };

  setNotDeleted = (path: string) => {
    const store = this.get_store();
    if (store == null) return;
    this.setRecentlyDeleted(path, 0);
  };

  private initProjectStatus = async () => {
    try {
      const client = await webapp_client.conat_client.projectConat({
        project_id: this.project_id,
        caller: "ProjectActions.initProjectStatus",
      });
      this.projectStatusSub = await getProjectStatus({
        client,
        project_id: this.project_id,
      });
      this.collaboratorRealtimeRetryCount = 0;
      this.clearCollaboratorRealtimeRetry();
    } catch (err) {
      if (isCollaboratorRealtimeAccessError(err)) {
        this.handleCollaboratorRealtimeAccessDenied();
        return;
      }
      if (!this.canUseCollaboratorRealtime()) {
        return;
      }
      console.warn(`unable to subscribe to project status updates: `, err);
      return;
    }
    for await (const mesg of this.projectStatusSub) {
      const status = mesg.data;
      this.setState({ status });
    }
  };

  projectApi = (opts?) => {
    return webapp_client.conat_client.projectApi({
      ...opts,
      project_id: this.project_id,
    });
  };

  private searchId = 0;
  search = async (opts?: { path?: string }) => {
    const store = this.get_store();
    if (!store) {
      return;
    }
    const searchId = ++this.searchId;
    const setState = (x) => {
      if (this.searchId != searchId) {
        // there's a newer search
        return;
      }
      this.setState(x);
    };
    const path = opts?.path ?? store.get("current_path_abs") ?? "/";
    const options = getSearch({
      project_id: this.project_id,
      path,
    });
    try {
      await search({
        setState,
        fs: this.fs(),
        query: store.get("user_input").trim(),
        path,
        options,
      });
    } catch (err) {
      setState({ search_error: `${err}` });
    }
  };
}
