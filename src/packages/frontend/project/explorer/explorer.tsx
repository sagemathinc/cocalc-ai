/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import * as _ from "lodash";
import { UsersViewing } from "@cocalc/frontend/account/avatar/users-viewing";
import { Button, Space } from "antd";
import { Col, Row } from "@cocalc/frontend/antd-bootstrap";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";
import {
  ActivityDisplay,
  ErrorDisplay,
  HelpIcon,
  Loading,
} from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { FileUploadWrapper } from "@cocalc/frontend/file-upload";
import { ProjectStatus } from "@cocalc/frontend/todo-types";
import { labels } from "@cocalc/frontend/i18n";
import AskNewFilename from "../ask-filename";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { selectionForPath } from "@cocalc/frontend/project/workspaces/state";
import { ActionBar } from "./action-bar";
import { ActionBox } from "./action-box";
import BackupOps from "./backup-ops";
import CopyOps from "./copy-ops";
import MoveOps from "./move-ops";
import RestoreOps from "./restore-ops";
import { FileListing } from "./file-listing";
import { default_ext } from "./file-listing/utils";
import { MiscSideButtons } from "./misc-side-buttons";
import { NewButton } from "./new-button";
import { PathNavigator } from "./path-navigator";
import { SearchBar } from "./search-bar";
import ExplorerTour from "./tour/tour";
import { dirname, join } from "path";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import useFs from "@cocalc/frontend/project/listing/use-fs";
import useListing, {
  type SortField,
} from "@cocalc/frontend/project/listing/use-listing";
import useBackupsListing, {
  isBackupsPath,
} from "@cocalc/frontend/project/listing/use-backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import filterListing from "@cocalc/frontend/project/listing/filter-listing";
import ShowError from "@cocalc/frontend/components/error";
import {
  getPublicFiles,
  useStrippedPublicPaths,
} from "@cocalc/frontend/project_store";
import { Icon } from "@cocalc/frontend/components";
import useCounter from "@cocalc/frontend/app-framework/counter-hook";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";
import { lite } from "@cocalc/frontend/lite";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import { isHostRoutingUnavailableError } from "@cocalc/frontend/projects/host-routing-error";
import { shouldSuppressTransientRoutingError } from "@cocalc/frontend/projects/host-routing-error";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import {
  navigateBrowsingPath,
  normalizeBrowsingPath,
} from "./navigate-browsing-path";
import {
  fileListingFingerprint,
  refreshListingAfterUserAction,
  useDeferredListing,
} from "./use-deferred-listing";
import { useExplorerSettings } from "./use-explorer-settings";
import { useNavigationHistory } from "./use-navigation-history";
import {
  DirectoryTreeDragbar,
  DIRECTORY_TREE_MIN_WIDTH_PX,
  DirectoryTreePanel,
  getDirectoryTreeWidth,
  setDirectoryTreeWidth,
} from "./directory-tree";
import { FileDndProvider } from "./dnd/file-dnd-provider";
import { getSortAsync, setSort } from "./config";
import { DEFAULT_ACTIVE_FILE_SORT, normalizeActiveFileSort } from "./sort";

const FLEX_ROW_STYLE = {
  display: "flex",
  flexFlow: "row wrap",
  justifyContent: "space-between",
  alignItems: "stretch",
} as const;

const ERROR_STYLE: CSSProperties = {
  marginRight: "1ex",
  whiteSpace: "pre-line",
  position: "absolute",
  zIndex: 15,
  right: "5px",
  boxShadow: "5px 5px 5px grey",
} as const;

function sortDesc(active_file_sort?): {
  sortField: SortField;
  sortDirection: "desc" | "asc";
} {
  const { column_name, is_descending } =
    normalizeActiveFileSort(active_file_sort);
  if (column_name == "time") {
    return {
      sortField: "mtime",
      sortDirection: is_descending ? "asc" : "desc",
    };
  }
  return {
    sortField: column_name as SortField,
    sortDirection: is_descending ? "desc" : "asc",
  };
}

export function Explorer() {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const {
    actions,
    project_id,
    registerUserFilesystemChangeHandler,
    workspaces,
  } = useProjectContext();

  const newFileRef = useRef<any>(null);
  const searchAndTerminalBar = useRef<any>(null);
  const fileListingRef = useRef<any>(null);
  const currentDirectoryRef = useRef<any>(null);
  const miscButtonsRef = useRef<any>(null);

  const activity = useTypedRedux({ project_id }, "activity")?.toJS();
  const available_features = useTypedRedux(
    { project_id },
    "available_features",
  )?.toJS();
  const checked_files = useTypedRedux({ project_id }, "checked_files");
  const configuration = useTypedRedux({ project_id }, "configuration");
  const current_path_abs = useTypedRedux({ project_id }, "current_path_abs");
  const explorer_browsing_path_abs = useTypedRedux(
    { project_id },
    "explorer_browsing_path_abs",
  );
  const explorer_history_path_abs = useTypedRedux(
    { project_id },
    "explorer_history_path_abs",
  );
  const effective_current_path =
    explorer_browsing_path_abs ?? current_path_abs ?? "/";
  const effective_history_path =
    explorer_history_path_abs ?? effective_current_path;
  const error = useTypedRedux({ project_id }, "error");
  const ext_selection = useTypedRedux({ project_id }, "ext_selection");
  const file_action = useTypedRedux({ project_id }, "file_action");
  const moveLro = useTypedRedux({ project_id }, "move_lro")?.toJS() as
    | MoveLroState
    | undefined;
  const file_creation_error = useTypedRedux(
    { project_id },
    "file_creation_error",
  );
  const file_search = useTypedRedux({ project_id }, "file_search") ?? "";
  const show_directory_tree =
    useTypedRedux({ project_id }, "show_directory_tree") ?? false;
  const disableExplorerKeyhandler = useTypedRedux(
    { project_id },
    "disableExplorerKeyhandler",
  );

  const [shiftIsDown, setShiftIsDown] = useState<boolean>(false);
  const [directoryTreeWidth, setDirectoryTreeWidthState] = useState<number>(
    () => getDirectoryTreeWidth(project_id),
  );

  const project_map = useTypedRedux("projects", "project_map");

  const otherSettings = useTypedRedux("account", "other_settings");
  const mask = otherSettings?.get("mask_files");
  const autoUpdateListing = !!otherSettings?.get("auto_update_file_listing");
  const host_id = project_map?.getIn([project_id, "host_id"]) as
    | string
    | undefined;
  const hostInfo = useHostInfo(host_id);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const hostUnavailable = !!host_id && hostOperational.state === "unavailable";
  const hostUnavailableReason =
    hostOperational.reason ?? "Assigned host is unavailable.";
  const assignedHostLabel = hostLabel(hostInfo, host_id);

  useExplorerSettings(project_id);
  const active_file_sort = normalizeActiveFileSort(
    useTypedRedux({ project_id }, "active_file_sort") ??
      DEFAULT_ACTIVE_FILE_SORT,
  );

  const fs = useFs({ project_id });
  const inBackupsPath = isBackupsPath(effective_current_path);
  const inSnapshotsPath = isSnapshotsPath(effective_current_path);
  const homePath =
    lite && typeof available_features?.homeDirectory === "string"
      ? normalizeAbsolutePath(available_features.homeDirectory)
      : "/root";
  const listingPath =
    inSnapshotsPath && !effective_current_path.startsWith("/")
      ? normalizeAbsolutePath(effective_current_path, homePath)
      : effective_current_path;
  let {
    refresh,
    listing,
    error: listingError,
  } = useListing({
    fs: inBackupsPath ? null : fs,
    path: listingPath,
    ...sortDesc(active_file_sort),
    cacheId: actions?.getCacheId(),
    mask,
  });
  const {
    listing: backupsListing,
    error: backupsError,
    refresh: refreshBackups,
  } = useBackupsListing({
    project_id,
    path: effective_current_path,
    ...sortDesc(active_file_sort),
  });
  const backupOps = useTypedRedux({ project_id }, "backup_ops");
  const prevBackupStatuses = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!backupOps) {
      prevBackupStatuses.current = new Map();
      return;
    }
    let shouldRefresh = false;
    const next = new Map<string, string>();
    backupOps.forEach((op, op_id) => {
      const status = op?.summary?.status;
      if (!status) return;
      next.set(op_id, status);
      if (
        status === "succeeded" &&
        prevBackupStatuses.current.get(op_id) !== status
      ) {
        shouldRefresh = true;
      }
    });
    for (const op_id of prevBackupStatuses.current.keys()) {
      if (!next.has(op_id)) {
        shouldRefresh = true;
        break;
      }
    }
    prevBackupStatuses.current = next;
    if (shouldRefresh) {
      refreshBackups();
    }
  }, [backupOps, refreshBackups]);
  if (inBackupsPath) {
    listing = backupsListing;
    listingError = backupsError;
    refresh = refreshBackups;
  }
  const showHidden = useTypedRedux({ project_id }, "show_hidden");
  const flyout = useTypedRedux({ project_id }, "flyout");
  const navigateExplorerRaw = useCallback(
    (path: string) => {
      navigateBrowsingPath(
        project_id,
        path,
        effective_history_path,
        "explorer_browsing_path_abs",
        "explorer_history_path_abs",
      );
    },
    [effective_history_path, project_id],
  );
  const navHistory = useNavigationHistory(
    project_id,
    effective_current_path,
    navigateExplorerRaw,
    "explorer",
  );
  const navigateExplorer = useCallback(
    (path: string) => {
      const normalized = normalizeBrowsingPath(path);
      navigateExplorerRaw(normalized);
      navHistory.recordNavigation(normalized);
    },
    [navigateExplorerRaw, navHistory],
  );

  listing = listingError
    ? null
    : filterListing({
        listing,
        search: file_search,
        showHidden,
      });

  const {
    displayListing,
    hasPending: hasPendingListingUpdate,
    flush: flushListingUpdates,
    allowNextUpdate: allowNextListingUpdate,
  } = useDeferredListing({
    liveListing: listing ?? undefined,
    currentPath: effective_current_path,
    alwaysPassThrough: autoUpdateListing,
    fingerprint: fileListingFingerprint,
  });
  const visibleListing = displayListing ?? listing;
  useEffect(() => {
    return registerUserFilesystemChangeHandler(allowNextListingUpdate);
  }, [allowNextListingUpdate, registerUserFilesystemChangeHandler]);

  const refreshSnapshotsAfterUserAction = useCallback(() => {
    refreshListingAfterUserAction({
      allowNextUpdate: allowNextListingUpdate,
      refresh,
    });
  }, [allowNextListingUpdate, refresh]);
  const refreshBackupsAfterUserAction = useCallback(() => {
    refreshListingAfterUserAction({
      allowNextUpdate: allowNextListingUpdate,
      refresh: refreshBackups,
    });
  }, [allowNextListingUpdate, refreshBackups]);
  const showDirectoryTreeAvailable =
    !IS_MOBILE &&
    !inBackupsPath &&
    !inSnapshotsPath &&
    effective_current_path.startsWith("/");
  const showDirectoryTreePanel =
    showDirectoryTreeAvailable && show_directory_tree;

  useEffect(() => {
    setDirectoryTreeWidthState(getDirectoryTreeWidth(project_id));
  }, [project_id]);

  const handleDirectoryTreeWidthChange = useCallback(
    (width: number) => {
      setDirectoryTreeWidthState(width);
      setDirectoryTreeWidth(project_id, width);
    },
    [project_id],
  );
  const handleAutoUpdateListingChange = useCallback((checked: boolean) => {
    redux
      .getActions("account")
      ?.set_other_settings("auto_update_file_listing", checked);
  }, []);

  useEffect(() => {
    actions?.setState({ numDisplayedFiles: visibleListing?.length ?? 0 });
  }, [actions, visibleListing?.length]);

  useEffect(() => {
    // Local explorer filters should update the visible listing immediately,
    // not show the deferred "Refresh" affordance that we reserve for incoming
    // filesystem changes.
    allowNextListingUpdate();
  }, [file_search, showHidden, allowNextListingUpdate]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nextSort = await getSortAsync({
        project_id,
        path: effective_current_path,
      });
      if (cancelled) return;
      const currentSort = normalizeActiveFileSort(
        redux.getProjectStore(project_id)?.get("active_file_sort"),
      );
      if (
        currentSort.column_name !== nextSort.column_name ||
        currentSort.is_descending !== nextSort.is_descending
      ) {
        actions?.setState({ active_file_sort: nextSort });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, effective_current_path, project_id]);

  // ensure that listing entries have isPublic set:
  const strippedPublicPaths = useStrippedPublicPaths(project_id);
  const publicFiles: Set<string> = useMemo(() => {
    if (visibleListing == null) {
      return new Set<string>();
    }
    return getPublicFiles(
      visibleListing,
      strippedPublicPaths,
      effective_current_path,
    );
  }, [visibleListing, effective_current_path, strippedPublicPaths]);

  const { val: clicked, inc: clickedOnExplorer } = useCounter();
  useEffect(() => {
    if (visibleListing == null || file_action || disableExplorerKeyhandler) {
      return;
    }
    const handleKeyDown = (e): void => {
      if (actions == null) {
        return;
      }
      if (e.key === "Shift") {
        setShiftIsDown(true);
        return;
      }
      if (flyout && $(":focus").length > 0) {
        return;
      }
      if (e.key == "ArrowUp") {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const path = dirname(effective_current_path);
          navigateExplorer(path == "." ? "/" : path);
        } else {
          actions.decrement_selected_file_index();
        }
      } else if (e.key == "ArrowDown") {
        actions.increment_selected_file_index();
      } else if (e.key == "Enter") {
        if (checked_files.size > 0 && file_action != undefined) {
          // using the action box.
          return;
        }
        if (file_search.startsWith("/")) {
          // running a terminal command
          return;
        }
        const n =
          redux.getProjectStore(project_id).get("selected_file_index") ?? 0;
        const x = visibleListing?.[n];
        if (x != null) {
          const { isDir, name } = x;
          const path = join(effective_current_path, name);
          const nextSelection = selectionForPath(workspaces.records, path);
          workspaces.setSelection(nextSelection);
          if (isDir) {
            navigateExplorer(path);
          } else {
            actions.open_file({ path, foreground: !e.ctrlKey });
          }
          setTimeout(() => workspaces.setSelection(nextSelection), 0);
          if (!e.ctrlKey) {
            setTimeout(() => actions.set_file_search(""), 10);
            actions.clear_selected_file_index();
          }
        }
      }
    };

    const handleKeyUp = (e): void => {
      if (e.key === "Shift") {
        setShiftIsDown(false);
      }
    };

    $(window).on("keydown", handleKeyDown);
    $(window).on("keyup", handleKeyUp);
    return () => {
      $(window).off("keydown", handleKeyDown);
      $(window).off("keyup", handleKeyUp);
    };
  }, [
    project_id,
    effective_current_path,
    visibleListing,
    file_action,
    flyout,
    clicked,
    disableExplorerKeyhandler,
    navigateExplorer,
  ]);

  if (actions == null) {
    return <Loading />;
  }

  const create_file = (ext, switch_over) => {
    if (switch_over == undefined) {
      switch_over = true;
    }
    if (
      ext == undefined &&
      file_search != null &&
      file_search.lastIndexOf(".") <= file_search.lastIndexOf("/")
    ) {
      const disabled_ext = // @ts-ignore
        configuration?.getIn(["main", "disabled_ext"])?.toJS?.() ?? [];
      ext = default_ext(disabled_ext);
    }

    actions.createFile({
      name: file_search ?? "",
      ext,
      current_path: effective_current_path,
      switch_over,
    });
    allowNextListingUpdate();
    actions.setState({ file_search: "" });
  };

  const create_folder = (switch_over = true): void => {
    actions.createFolder({
      name: file_search ?? "",
      current_path: effective_current_path,
      switch_over,
    });
    allowNextListingUpdate();
    actions.setState({ file_search: "" });
  };

  let project_is_running: boolean, project_state: ProjectStatus | undefined;

  if (checked_files == undefined) {
    // hasn't loaded/initialized at all
    return <Loading />;
  }

  const my_group = redux.getStore("projects").get_my_group(project_id);

  // regardless of consequences, for admins a project is always running
  // see https://github.com/sagemathinc/cocalc/issues/3863
  if (my_group === "admin") {
    project_state = new ProjectStatus({ state: "running" });
    project_is_running = true;
    // next, we check if this is a common user (not public)
  } else if (my_group !== "public") {
    project_state = project_map?.getIn([project_id, "state"]) as any;
    const displayState = normalizeProjectStateForDisplay({
      projectState: project_state?.get("state"),
      hostId: host_id,
      hostInfo,
    });
    project_is_running = displayState === "running";
  } else {
    project_is_running = false;
  }

  if (listingError?.code == 403 || listingError?.code == 408) {
    // 403 = permission denied, 408 = connection being closed (due to permission?)
    return (
      <div style={{ margin: "30px auto", textAlign: "center" }}>
        <ShowError
          message={`Permission Issues: You are probably using the wrong account to access this ${projectLabelLower}.`}
          error={listingError}
          style={{ textAlign: "left" }}
        />
        <br />
        <Space.Compact>
          <Button
            size="large"
            type="primary"
            style={{ margin: "auto" }}
            onClick={() => {
              redux.getActions("page").close_project_tab(project_id);
            }}
          >
            <Icon name="times-circle" /> Close {projectLabel}
          </Button>
        </Space.Compact>
      </div>
    );
  }

  const suppressRoutingError =
    (hostUnavailable && isHostRoutingUnavailableError(listingError)) ||
    shouldSuppressTransientRoutingError({ error: listingError, moveLro });
  const suppressProjectError =
    (hostUnavailable && isHostRoutingUnavailableError(error)) ||
    shouldSuppressTransientRoutingError({ error, moveLro });

  const transientRoutingRetryRef = useRef<string>("");
  useEffect(() => {
    if (!listingError) return;
    if (
      !shouldSuppressTransientRoutingError({ error: listingError, moveLro })
    ) {
      return;
    }
    const msg = `${(listingError as any)?.message ?? listingError}`;
    const token = `${effective_current_path}|${msg}`;
    if (transientRoutingRetryRef.current === token) return;
    transientRoutingRetryRef.current = token;
    const timer = setTimeout(() => refresh(), 1200);
    return () => clearTimeout(timer);
  }, [listingError, moveLro, effective_current_path, refresh]);

  const clearedTransientProjectErrorRef = useRef<string>("");
  useEffect(() => {
    if (!error) return;
    if (!shouldSuppressTransientRoutingError({ error, moveLro })) return;
    const msg = `${(error as any)?.message ?? error}`;
    if (clearedTransientProjectErrorRef.current === msg) return;
    clearedTransientProjectErrorRef.current = msg;
    actions?.setState({ error: "" });
  }, [error, moveLro, actions]);

  if (hostUnavailable && !project_is_running) {
    return (
      <div
        style={{
          margin: "40px auto",
          maxWidth: "820px",
          padding: "0 20px",
          textAlign: "left",
        }}
      >
        <ShowError
          message={`${projectLabel} host is not available`}
          error={`This ${projectLabelLower} is assigned to ${assignedHostLabel}, which is unavailable (${hostUnavailableReason}).

You can either wait for this host to become available again, or move this ${projectLabelLower} to another host.`}
          style={{ textAlign: "left" }}
        />
        <br />
        <Space.Compact>
          <Button size="large" style={{ margin: "auto" }} onClick={refresh}>
            <Icon name="refresh" /> Wait / Refresh
          </Button>
          <MoveProject
            project_id={project_id}
            size="large"
            label="Move Project"
            showHostName={false}
          />
        </Space.Compact>
      </div>
    );
  }

  // be careful with adding height:'100%'. it could cause flex to miscalculate. see #3904
  return (
    <FileDndProvider
      project_id={project_id}
      onUserFilesystemChange={allowNextListingUpdate}
    >
      <div
        className={"smc-vfill"}
        onClick={() => {
          clickedOnExplorer();
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            padding: "2px 2px 0 2px",
          }}
        >
          {!suppressProjectError && error && (
            <ErrorDisplay
              error={error}
              style={ERROR_STYLE}
              onClose={() => actions.setState({ error: "" })}
            />
          )}
          <ActivityDisplay
            trunc={80}
            activity={_.values(activity)}
            on_clear={() => actions.clear_all_activity()}
            style={{ top: "100px" }}
          />
          <BackupOps project_id={project_id} />
          <RestoreOps project_id={project_id} />
          <MoveOps project_id={project_id} />
          <CopyOps project_id={project_id} />
          <div
            style={{
              display: "flex",
              flexFlow: IS_MOBILE ? undefined : "row wrap",
              justifyContent: "space-between",
              alignItems: "stretch",
              marginBottom: "15px",
            }}
          >
            <div
              style={{
                flex: "3 1 auto",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ display: "flex", flex: "1 1 auto" }}>
                <div
                  ref={currentDirectoryRef}
                  className="cc-project-files-path-nav"
                >
                  <PathNavigator
                    project_id={project_id}
                    showSourceSelector
                    currentPath={effective_current_path}
                    historyPath={effective_history_path}
                    onNavigate={navigateExplorer}
                    canGoBack={navHistory.canGoBack}
                    canGoForward={navHistory.canGoForward}
                    onGoBack={navHistory.goBack}
                    onGoForward={navHistory.goForward}
                    backHistory={navHistory.backHistory}
                    forwardHistory={navHistory.forwardHistory}
                  />
                </div>
              </div>
            </div>
            {!IS_MOBILE && (
              <div
                style={{
                  flex: "0 1 auto",
                  margin: "0 10px",
                }}
                className="cc-project-files-create-dropdown"
              >
                <div ref={newFileRef}>
                  <NewButton
                    project_id={project_id}
                    file_search={file_search ?? ""}
                    current_path={effective_current_path}
                    actions={actions}
                    create_file={create_file}
                    create_folder={create_folder}
                    configuration={configuration}
                    disabled={!!ext_selection}
                  />
                </div>
              </div>
            )}
            {!IS_MOBILE && (
              <div style={{ flex: "1 1 auto" }} ref={searchAndTerminalBar}>
                <SearchBar
                  actions={actions}
                  current_path={effective_current_path}
                  file_search={file_search ?? ""}
                  file_creation_error={file_creation_error}
                  create_file={create_file}
                  create_folder={create_folder}
                  onTerminalCommand={allowNextListingUpdate}
                />
              </div>
            )}
            <div
              style={{
                flex: "0 1 auto",
              }}
            >
              <UsersViewing project_id={project_id} />
            </div>
          </div>
        </div>
        {ext_selection != null && <AskNewFilename project_id={project_id} />}
        <div
          ref={fileListingRef}
          className="smc-vfill"
          style={{
            flex: "1 1 0",
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            minHeight: 0,
            padding: "0 5px 5px 5px",
          }}
        >
          {showDirectoryTreeAvailable && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: showDirectoryTreePanel
                  ? `0 0 ${directoryTreeWidth}px`
                  : "0 0 40px",
                width: showDirectoryTreePanel ? directoryTreeWidth : 40,
                minWidth: showDirectoryTreePanel
                  ? DIRECTORY_TREE_MIN_WIDTH_PX
                  : 40,
                minHeight: 0,
                overflow: "hidden",
                paddingRight: showDirectoryTreePanel ? "4px" : "0",
              }}
            >
              <div
                style={{
                  flex: "0 0 auto",
                  padding: showDirectoryTreePanel ? "4px 2px 8px 2px" : "0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: showDirectoryTreePanel
                    ? "flex-start"
                    : "center",
                  gap: "6px",
                }}
              >
                <Button
                  onClick={() =>
                    actions?.setState({
                      show_directory_tree: !show_directory_tree,
                    })
                  }
                  style={{ minWidth: 32, height: 30, paddingInline: 8 }}
                  title={
                    showDirectoryTreePanel
                      ? "Hide directory tree"
                      : "Show directory tree"
                  }
                >
                  <Icon
                    name="network"
                    style={{
                      transform: showDirectoryTreePanel
                        ? "rotate(270deg)"
                        : undefined,
                    }}
                  />
                </Button>
                {showDirectoryTreePanel && (
                  <span style={{ whiteSpace: "nowrap" }}>
                    Directory Tree{" "}
                    <HelpIcon title="Directory Tree" maxWidth="300px">
                      <ul style={{ paddingLeft: "18px", margin: 0 }}>
                        <li>Quickly navigate to any directory.</li>
                        <li>
                          Star directories for quick access. They appear at the
                          top.
                        </li>
                        <li>Drag the border to resize the panel width.</li>
                        <li>
                          Drag and drop files onto directories to move them.
                        </li>
                        <li>
                          Hold <b>Shift</b> while dropping to copy instead of
                          move.
                        </li>
                      </ul>
                    </HelpIcon>
                  </span>
                )}
              </div>
              {showDirectoryTreePanel && (
                <DirectoryTreePanel
                  project_id={project_id}
                  current_path={effective_current_path}
                  show_hidden={showHidden ?? false}
                  homeDirectory={homePath}
                  on_open_directory={navigateExplorer}
                />
              )}
            </div>
          )}
          {showDirectoryTreePanel && (
            <DirectoryTreeDragbar
              currentWidth={directoryTreeWidth}
              onWidthChange={handleDirectoryTreeWidthChange}
              onReset={() =>
                handleDirectoryTreeWidthChange(
                  getDirectoryTreeWidth(project_id),
                )
              }
            />
          )}
          <div
            className="smc-vfill"
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ flex: "0 0 auto" }}>
              <div style={FLEX_ROW_STYLE}>
                <div
                  style={{
                    display: "flex",
                    flex: "1 0 auto",
                    marginRight: "5px",
                    minWidth: "20em",
                  }}
                >
                  {!lite && (
                    <DiskUsage
                      style={{ marginRight: "5px" }}
                      project_id={project_id}
                    />
                  )}
                  {visibleListing != null && (
                    <ActionBar
                      listing={visibleListing}
                      project_id={project_id}
                      checked_files={checked_files}
                      current_path={effective_current_path}
                      actions={actions}
                      refreshBackups={refreshBackups}
                      hasPendingUpdate={hasPendingListingUpdate}
                      onRefreshListing={flushListingUpdates}
                      autoUpdateListing={autoUpdateListing}
                      onToggleAutoUpdate={handleAutoUpdateListingChange}
                    />
                  )}
                </div>
                <div
                  ref={miscButtonsRef}
                  style={{
                    flex: "1 0 auto",
                    marginBottom: "15px",
                    textAlign: "right",
                  }}
                >
                  <MiscSideButtons
                    refreshSnapshots={refreshSnapshotsAfterUserAction}
                    refreshBackups={refreshBackupsAfterUserAction}
                  />
                </div>
              </div>
              {checked_files.size > 0 && file_action != undefined ? (
                <Row>
                  <Col sm={12}>
                    <ActionBox
                      file_action={file_action}
                      checked_files={checked_files}
                      current_path={effective_current_path}
                      project_id={project_id}
                      actions={actions}
                      onUserFilesystemChange={allowNextListingUpdate}
                    />
                  </Col>
                </Row>
              ) : undefined}
            </div>

            {listingError && !suppressRoutingError && (
              <div style={{ margin: "30px auto", textAlign: "center" }}>
                <ShowError error={listingError} style={{ textAlign: "left" }} />
                <br />
                <Space.Compact>
                  <Button
                    size="large"
                    style={{ margin: "auto" }}
                    onClick={refresh}
                  >
                    <Icon name="refresh" /> Refresh
                  </Button>
                  {listingError.code == "ENOENT" && (
                    <Button
                      size="large"
                      style={{ margin: "auto" }}
                      onClick={async () => {
                        const fs = actions?.fs();
                        try {
                          await fs.mkdir(effective_current_path, {
                            recursive: true,
                          });
                          refresh();
                        } catch (err) {
                          actions?.setState({ error: err });
                        }
                      }}
                    >
                      <Icon name="folder-open" /> Create Directory
                    </Button>
                  )}
                </Space.Compact>
              </div>
            )}

            {!listingError && (
              <>
                <FileUploadWrapper
                  project_id={project_id}
                  dest_path={effective_current_path}
                  config={{ clickable: ".upload-button" }}
                  event_handlers={{
                    complete: () => allowNextListingUpdate(),
                  }}
                  style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                  }}
                  className="smc-vfill"
                >
                  {visibleListing == null ? (
                    <div style={{ textAlign: "center" }}>
                      <Loading delay={1000} theme="medium" />
                    </div>
                  ) : (
                    <FileListing
                      active_file_sort={active_file_sort}
                      sort_by={(column_name: string) => {
                        allowNextListingUpdate();
                        void setSort({
                          project_id,
                          path: effective_current_path,
                          column_name,
                        });
                      }}
                      listing={visibleListing}
                      file_search={file_search}
                      checked_files={checked_files}
                      current_path={effective_current_path}
                      actions={actions}
                      project_id={project_id}
                      shiftIsDown={shiftIsDown}
                      publicFiles={publicFiles}
                      onNavigateDirectory={navigateExplorer}
                    />
                  )}
                </FileUploadWrapper>
              </>
            )}
          </div>
        </div>
        <ExplorerTour
          project_id={project_id}
          newFileRef={newFileRef}
          searchAndTerminalBar={searchAndTerminalBar}
          fileListingRef={fileListingRef}
          currentDirectoryRef={currentDirectoryRef}
          miscButtonsRef={miscButtonsRef}
        />
      </div>
    </FileDndProvider>
  );
}
