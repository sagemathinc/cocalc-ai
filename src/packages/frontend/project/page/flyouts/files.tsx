/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, InputRef } from "antd";
import { List } from "immutable";
import { debounce, fromPairs } from "lodash";
import { VirtuosoHandle } from "react-virtuoso";
import {
  React,
  redux,
  usePrevious,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { Loading, TimeAgo } from "@cocalc/frontend/components";
import StatefulVirtuoso from "@cocalc/frontend/components/stateful-virtuoso";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { FileUploadWrapper } from "@cocalc/frontend/file-upload";
import { should_open_in_foreground } from "@cocalc/frontend/lib/should-open-in-foreground";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { computeFileMasks } from "@cocalc/frontend/project/explorer/compute-file-masks";
import {
  DirectoryListing,
  DirectoryListingEntry,
  FileMap,
} from "@cocalc/frontend/project/explorer/types";
import {
  getPublicFiles,
  useStrippedPublicPaths,
} from "@cocalc/frontend/project_store";
import track from "@cocalc/frontend/user-tracking";
import {
  capitalize,
  filename_extension,
  human_readable_size,
  path_split,
  path_to_file,
  separate_file_extension,
  tab_to_path,
  unreachable,
} from "@cocalc/util/misc";
import {
  FLYOUT_EXTRA2_WIDTH_PX,
  FLYOUT_EXTRA_WIDTH_PX,
  FLYOUT_PADDING,
} from "./consts";
import { FileListItem } from "./file-list-item";
import { FilesBottom } from "./files-bottom";
import { FilesHeader } from "./files-header";
import { fileItemStyle } from "./utils";
import { triggerFlyoutFileAction } from "./file-action-trigger";
import useFs from "@cocalc/frontend/project/listing/use-fs";
import useListing from "@cocalc/frontend/project/listing/use-listing";
import useBackupsListing, {
  isBackupsPath,
} from "@cocalc/frontend/project/listing/use-backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import ShowError from "@cocalc/frontend/components/error";
import { useSpecialPathPreview } from "@cocalc/frontend/project/explorer/use-special-path-preview";
import { useFlyoutSettings } from "@cocalc/frontend/project/explorer/use-explorer-settings";
import { lite } from "@cocalc/frontend/lite";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { selectionForPath } from "@cocalc/frontend/project/workspaces/state";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  hostLabel,
} from "@cocalc/frontend/projects/host-operational";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import {
  isHostRoutingUnavailableError,
  shouldSuppressTransientRoutingError,
} from "@cocalc/frontend/projects/host-routing-error";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import { FileDndProvider } from "@cocalc/frontend/project/explorer/dnd/file-dnd-provider";
import { useFlyoutNavigation } from "./use-flyout-navigation";
import { sortedTypeFilterOptions } from "@cocalc/frontend/project/explorer/file-listing/utils";
import {
  fileListingFingerprint,
  refreshListingAfterUserAction,
  useDeferredListing,
} from "@cocalc/frontend/project/explorer/use-deferred-listing";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";

type PartialClickEvent = Pick<
  React.MouseEvent | React.KeyboardEvent,
  "detail" | "shiftKey" | "ctrlKey" | "metaKey" | "stopPropagation"
>;

const EMPTY_DIRECTORY_FILES: DirectoryListing = [];

function isMissingProjectVolumeError(error: unknown): boolean {
  const text = `${(error as any)?.message ?? error ?? ""}`.toLowerCase();
  return text.includes("project volume does not exist");
}

export interface ActiveFileSort {
  column_name: string;
  is_descending: boolean;
}

function typeFilterValue(file: DirectoryListingEntry): string {
  if (file.isDir) {
    return "folder";
  }
  return filename_extension(file.name)?.toLowerCase() || "(none)";
}

export function FilesFlyout({
  flyoutWidth,
}: {
  flyoutWidth: number;
}): React.JSX.Element {
  const {
    isRunning: projectIsRunning,
    project_id,
    actions,
    manageStarredFiles,
    registerUserFilesystemChangeHandler,
    workspaces,
  } = useProjectContext();
  const rootRef = useRef<HTMLDivElement>(null as any);
  const refInput = useRef<InputRef>(null as any);
  const [rootHeightPx, setRootHeightPx] = useState<number>(0);
  const [showCheckboxIndex, setShowCheckboxIndex] = useState<number | null>(
    null,
  );
  const { flyoutPath: effective_current_path, navigateFlyout } =
    useFlyoutNavigation(project_id);
  const project_map = useTypedRedux("projects", "project_map");
  const host_id = project_map?.getIn([project_id, "host_id"]) as
    | string
    | undefined;
  const hostInfo = useHostInfo(host_id);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const hostUnavailable = !!host_id && hostOperational.state === "unavailable";
  const moveLro = useTypedRedux({ project_id }, "move_lro")?.toJS() as
    | MoveLroState
    | undefined;
  const hostUnavailableReason =
    hostOperational.reason ?? "Assigned host is unavailable.";
  const assignedHostLabel = hostLabel(hostInfo, host_id);
  const available_features = useTypedRedux(
    { project_id },
    "available_features",
  )?.toJS();
  const { onOpenSpecial, modal } = useSpecialPathPreview({
    project_id,
    actions,
    current_path: effective_current_path,
  });
  const strippedPublicPaths = useStrippedPublicPaths(project_id);
  const activeTab = useTypedRedux({ project_id }, "active_project_tab");

  const [activeFileSort, setActiveFileSort] = useFlyoutSettings(project_id);

  const file_search = useTypedRedux({ project_id }, "file_search") ?? "";
  const otherSettings = useTypedRedux("account", "other_settings");
  const show_masked = useTypedRedux({ project_id }, "show_masked");
  const hidden = useTypedRedux({ project_id }, "show_hidden");
  const typeFilter = useTypedRedux({ project_id }, "type_filter") ?? null;
  const checked_files = useTypedRedux({ project_id }, "checked_files");
  const openFiles = new Set<string>(
    useTypedRedux({ project_id }, "open_files_order")?.toJS() ?? [],
  );
  // mainly controls what a single click does, plus additional UI elements
  const [mode, setMode] = useState<"open" | "select">("open");
  const [prevSelected, setPrevSelected] = useState<number | null>(null);
  const [scrollIdx, setScrollIdx] = useState<number | null>(null);
  const [scrollIdxHide, setScrollIdxHide] = useState<boolean>(false);
  const [selectionOnMouseDown, setSelectionOnMouseDown] = useState<string>("");
  const student_project_functionality =
    useStudentProjectFunctionality(project_id);
  const disableUploads = student_project_functionality.disableUploads ?? false;
  const virtuosoRef = useRef<VirtuosoHandle>(null as any);
  const activePath = useMemo(() => {
    return tab_to_path(activeTab);
  }, [activeTab]);
  const setTypeFilter = (val: string | null) => {
    actions?.setState({ type_filter: val ?? undefined } as any);
  };

  // selecting files switches over to "select" mode or back to "open"
  useEffect(() => {
    if (mode === "open" && checked_files.size > 0) {
      setMode("select");
    }
    if (mode === "select" && checked_files.size === 0) {
      setMode("open");
    }
  }, [checked_files]);

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
  const fs = useFs({ project_id });
  const {
    listing: directoryListing,
    error: listingError,
    refresh,
  } = useListing({
    fs: inBackupsPath ? null : fs,
    path: listingPath,
  });
  const {
    listing: backupsListing,
    error: backupsError,
    refresh: refreshBackups,
  } = useBackupsListing({
    project_id,
    path: effective_current_path,
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
  const effectiveListing = inBackupsPath ? backupsListing : directoryListing;
  const effectiveError = inBackupsPath ? backupsError : listingError;
  const shouldShowStartProjectWarning =
    !projectIsRunning && isMissingProjectVolumeError(effectiveError);
  const suppressRoutingError =
    (hostUnavailable && isHostRoutingUnavailableError(effectiveError)) ||
    shouldSuppressTransientRoutingError({ error: effectiveError, moveLro });
  const effectiveRefresh = inBackupsPath ? refreshBackups : refresh;
  const autoUpdateListing = !!otherSettings?.get("auto_update_file_listing");
  const typeFilterOptions = useMemo(() => {
    const extensions = new Set<string>();
    for (const file of effectiveListing ?? []) {
      if (!show_masked && file.mask === true) continue;
      if (!hidden && file.name.startsWith(".")) continue;
      extensions.add(typeFilterValue(file));
    }
    return sortedTypeFilterOptions(extensions);
  }, [effectiveListing, hidden, show_masked]);
  const transientRoutingRetryRef = useRef<string>("");
  useEffect(() => {
    if (!effectiveError) return;
    if (
      !shouldSuppressTransientRoutingError({ error: effectiveError, moveLro })
    ) {
      return;
    }
    const msg = `${(effectiveError as any)?.message ?? effectiveError}`;
    const token = `${effective_current_path}|${msg}`;
    if (transientRoutingRetryRef.current === token) return;
    transientRoutingRetryRef.current = token;
    const timer = setTimeout(() => effectiveRefresh(), 1200);
    return () => clearTimeout(timer);
  }, [effectiveError, moveLro, effective_current_path, effectiveRefresh]);

  const liveDirectoryFiles = useMemo((): DirectoryListing | undefined => {
    const files = effectiveListing;
    if (files == null) return undefined;
    computeFileMasks(files);
    const searchWords = file_search.trim().toLowerCase();

    const processedFiles: DirectoryListingEntry[] = files
      .filter((file: DirectoryListingEntry) => {
        if (file_search === "") return true;
        const filename = file.name.toLowerCase();
        return (
          filename.includes(searchWords) ||
          (file.isDir && `${filename}/`.includes(searchWords))
        );
      })
      .filter(
        (file: DirectoryListingEntry) => show_masked || !(file.mask === true),
      )
      .filter(
        (file: DirectoryListingEntry) => hidden || !file.name.startsWith("."),
      )
      .filter((file: DirectoryListingEntry) =>
        typeFilter == null ? true : typeFilterValue(file) === typeFilter,
      );

    processedFiles.sort((a, b) => {
      // This replicated what project_store is doing
      const col = activeFileSort.column_name;
      switch (col as string) {
        case "name":
          return a.name.localeCompare(b.name);
        case "size":
          return (a.size ?? 0) - (b.size ?? 0);
        case "time":
          return (b.mtime ?? 0) - (a.mtime ?? 0);
        case "type":
          const aDir = a.isDir ?? false;
          const bDir = b.isDir ?? false;
          if (aDir && !bDir) return -1;
          if (!aDir && bDir) return 1;
          const aExt = a.name.split(".").pop() ?? "";
          const bExt = b.name.split(".").pop() ?? "";
          return aExt.localeCompare(bExt);
        case "starred":
          const pathA = path_to_file(effective_current_path, a.name);
          const pathB = path_to_file(effective_current_path, b.name);
          const starPathA = a.isDir ? `${pathA}/` : pathA;
          const starPathB = b.isDir ? `${pathB}/` : pathB;
          const starredA = manageStarredFiles.starred.includes(starPathA);
          const starredB = manageStarredFiles.starred.includes(starPathB);

          if (starredA && !starredB) {
            return -1;
          } else if (!starredA && starredB) {
            return 1;
          } else {
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          }
        default:
          console.warn(`flyout/files: unknown sort column ${col}`);
          return 0;
      }
    });

    if (activeFileSort.is_descending) {
      processedFiles.reverse(); // inplace op
    }

    // the ".." dir does not change the isEmpty state
    // hide ".." if there is a search -- https://github.com/sagemathinc/cocalc/issues/6877
    if (file_search === "" && effective_current_path !== "/") {
      processedFiles.unshift({
        name: "..",
        isDir: true,
        size: -1, // not used and we don't know the size in bytes
        mtime: 0, // also not known
      });
    }

    // map each filename to it's entry in the directory listing
    return processedFiles;
  }, [
    effectiveListing,
    activeFileSort,
    hidden,
    file_search,
    show_masked,
    typeFilter,
    effective_current_path,
    strippedPublicPaths,
  ]);
  const {
    displayListing: deferredDirectoryFiles,
    hasPending: hasPendingListingUpdate,
    flush: flushListingUpdate,
    allowNextUpdate: allowNextListingUpdate,
  } = useDeferredListing({
    liveListing: liveDirectoryFiles,
    currentPath: effective_current_path,
    alwaysPassThrough: autoUpdateListing,
    fingerprint: fileListingFingerprint,
  });
  useEffect(() => {
    return registerUserFilesystemChangeHandler(() =>
      refreshListingAfterUserAction({
        allowNextUpdate: allowNextListingUpdate,
        refresh: effectiveRefresh,
      }),
    );
  }, [
    allowNextListingUpdate,
    effectiveRefresh,
    registerUserFilesystemChangeHandler,
  ]);

  const directoryFiles =
    deferredDirectoryFiles ?? liveDirectoryFiles ?? EMPTY_DIRECTORY_FILES;
  const fileMap = useMemo<FileMap>(
    () => fromPairs(directoryFiles.map((file) => [file.name, file])),
    [directoryFiles],
  );
  const activeFile: DirectoryListingEntry | null = null;
  const isEmpty = useMemo(
    () => directoryFiles.filter((file) => file.name !== "..").length === 0,
    [directoryFiles],
  );

  const isOpen = (file) =>
    openFiles.has(path_to_file(effective_current_path, file.name));
  const isActive = (file) =>
    activePath == path_to_file(effective_current_path, file.name);

  const publicFiles = getPublicFiles(
    directoryFiles,
    strippedPublicPaths,
    effective_current_path,
  );

  const prev_current_path = usePrevious(effective_current_path);
  const prevCheckedSize = useRef(checked_files?.size ?? 0);

  useEffect(() => {
    if (prevCheckedSize.current > 0 && (checked_files?.size ?? 0) === 0) {
      allowNextListingUpdate();
    }
    prevCheckedSize.current = checked_files?.size ?? 0;
  }, [checked_files?.size, allowNextListingUpdate]);

  useEffect(() => {
    allowNextListingUpdate();
  }, [
    activeFileSort,
    file_search,
    hidden,
    show_masked,
    typeFilter,
    allowNextListingUpdate,
  ]);

  useEffect(() => {
    // reset prev selection if path changes
    setPrevSelected(null);

    // if the current_path changes and there was a previous one,
    // we reset the checked files as well. This should probably be somewhere in the actions, though.
    // The edge case is when more than one editor in different directories is open,
    // and you switch between the two. Checked files are not reset in that case.
    if (prev_current_path !== effective_current_path) {
      actions?.set_all_files_unchecked();
    }

    // if we change directory *and* use the keyboard, we re-focus the input
    if (scrollIdx != null) {
      refInput.current?.focus();
    }
    setScrollIdx(null);
  }, [effective_current_path]);

  useEffect(() => {
    setShowCheckboxIndex(null);
  }, [directoryListing, effective_current_path]);

  const triggerRootResize = debounce(
    () => setRootHeightPx(rootRef.current?.clientHeight ?? 0),
    50,
    { leading: false, trailing: true },
  );

  // observe the root element's height
  useLayoutEffect(() => {
    if (rootRef.current == null) return;
    const observer = new ResizeObserver(triggerRootResize);
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  const [showExtra, showExtra2] = useMemo(() => {
    return [
      flyoutWidth > FLYOUT_EXTRA_WIDTH_PX,
      flyoutWidth > FLYOUT_EXTRA2_WIDTH_PX,
    ];
  }, [flyoutWidth]);

  const setSearchState = (val: string) => {
    actions?.set_file_search(val);
  };

  const handleSearchChange = (val: string) => {
    setScrollIdx(null);
    setSearchState(val);
  };

  // incoming search state change
  useEffect(() => {
    setScrollIdx(null);
  }, [file_search]);

  // *** END HOOKS ***

  function getFile(name: string): DirectoryListingEntry | undefined {
    const basename = path_split(name).tail;
    return fileMap[basename];
  }

  function open(
    e: PartialClickEvent,
    index: number,
    skip = false, // to exclude directories
  ) {
    e?.stopPropagation();
    const file = directoryFiles[index];
    if (file == null) return;

    if (!skip) {
      const fullPath = path_to_file(effective_current_path, file.name);
      const nextSelection = selectionForPath(workspaces.records, fullPath);
      workspaces.setSelection(nextSelection);

      if (file.isDir) {
        // true: change history, false: do not show "files" page
        navigateFlyout(fullPath);
        setTimeout(() => workspaces.setSelection(nextSelection), 0);
        setSearchState("");
      } else {
        if (onOpenSpecial(fullPath, false)) {
          return;
        }
        const foreground = should_open_in_foreground(e as React.MouseEvent);
        track("open-file", {
          project_id,
          path: fullPath,
          how: "click-on-listing-flyout",
        });
        actions?.open_file({
          path: fullPath,
          foreground,
          explicit: true,
        });
        setTimeout(() => workspaces.setSelection(nextSelection), 0);
      }
    }

    const fn = file.name;
    if (checked_files.includes(fn)) {
      actions?.set_file_list_unchecked(List([fn]));
    }
  }

  function toggleSelected(index: number, fn: string, nextState?: boolean) {
    // never select "..", only calls for trouble
    if (fn === "..") return;
    fn = path_to_file(effective_current_path, fn);
    window.getSelection()?.removeAllRanges();
    if (nextState != null ? !nextState : checked_files.includes(fn)) {
      // deselects the file
      actions?.set_file_list_unchecked(List([fn]));
      if (checked_files.size <= 1) {
        setPrevSelected(null);
      } else {
        setPrevSelected(index);
      }
    } else {
      // selects the file
      actions?.set_file_list_checked([fn]);
      setPrevSelected(index);
    }
  }

  function handleFileClick(e: PartialClickEvent | undefined, index: number) {
    e ??= {
      detail: 1, // single click
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      stopPropagation: () => {},
    };
    // "hack" from explorer/file-listing/file-row.tsx to avoid a click,
    // if the user selects the filename -- ignore double clicks, though.
    if (
      e?.detail !== 2 &&
      (window.getSelection()?.toString() ?? "") !== selectionOnMouseDown
    ) {
      return;
    }

    // deselect text if any
    window.getSelection()?.removeAllRanges();
    const file = directoryFiles[index];

    // double click straight to open file
    if (e.detail === 2) {
      setPrevSelected(index);
      open(e, index);
      return;
    }

    // similar, if in open mode and already opened, just switch to it as well
    if (mode === "open" && isOpen(file) && !e.shiftKey && !e.ctrlKey) {
      setPrevSelected(index);
      open(e, index);
      return;
    }

    // shift-click selects whole range from last selected (if not null) to current index
    if (e.shiftKey) {
      if (prevSelected != null) {
        const start = Math.min(prevSelected, index);
        const end = Math.max(prevSelected, index);
        const add = !checked_files.includes(
          path_to_file(effective_current_path, directoryFiles[index].name),
        );
        let fileNames: string[] = [];
        for (let i = start; i <= end; i++) {
          const fn = directoryFiles[i].name;
          if (fn === "..") continue; // don't select parent dir, just calls for trouble
          fileNames.push(path_to_file(effective_current_path, fn));
        }
        if (add) {
          actions?.set_file_list_checked(fileNames);
        } else {
          actions?.set_file_list_unchecked(List(fileNames));
        }
        return;
      } else {
        toggleSelected(index, file.name);
        setPrevSelected(index);
        return;
      }
    }

    switch (mode) {
      case "select":
        toggleSelected(index, file.name);
        break;

      case "open":
        if (e.shiftKey) {
          // Shift case: no prevSelected, otherwise see above
          toggleSelected(index, file.name);
        } else {
          setPrevSelected(index);
          open(e, index);
        }
        break;

      default:
        unreachable(mode);
    }
  }

  function showFileSharingDialog(file?: { name: string }) {
    if (!file) return;
    const fullPath = path_to_file(effective_current_path, file.name);
    triggerFlyoutFileAction({
      actions,
      action: "share",
      path: fullPath,
      multiple: false,
    });
  }

  function renderTimeAgo(item: DirectoryListingEntry) {
    const { mtime } = item;
    if (typeof mtime === "number") {
      return (
        <TimeAgo
          date={mtime}
          // don't popup the toggle if you just clicked to open the file
          click_to_toggle={isOpen(item)}
        />
      );
    }
  }

  function renderListItemExtra(item: DirectoryListingEntry) {
    if (!showExtra) return null;
    const col = activeFileSort.column_name;
    switch (col as string) {
      case "time":
        return renderTimeAgo(item);
      case "type":
        if (item.isDir) return "Folder";
        const { ext } = separate_file_extension(item.name);
        return capitalize(file_options(item.name).name) || ext;
      case "name":
      case "size":
        return item.isDir ? "" : human_readable_size(item.size, true);
      default:
        return null;
    }
  }

  function renderListItemExtra2(item: DirectoryListingEntry) {
    if (!showExtra2) return;
    const col = activeFileSort.column_name;
    switch (col as string) {
      case "time":
      case "type":
        return item.isDir ? "" : human_readable_size(item.size, true);
      case "size":
      case "name":
        return renderTimeAgo(item);
      default:
        return null;
    }
  }

  function renderListItem(index: number, item: DirectoryListingEntry) {
    const { mtime, mask = false } = item;
    const age = typeof mtime === "number" ? mtime : null;
    // either select by scrolling (and only scrolling!) or by clicks
    const isSelected =
      scrollIdx != null
        ? !scrollIdxHide && index === scrollIdx
        : checked_files.includes(
            path_to_file(effective_current_path, directoryFiles[index].name),
          );
    const fullPath = path_to_file(effective_current_path, item.name);
    const pathForStar = item.isDir ? `${fullPath}/` : fullPath;
    const isStarred = manageStarredFiles.starred.includes(pathForStar);
    return (
      <FileListItem
        mode="files"
        item={{
          ...item,
          isPublic: publicFiles.has(item.name),
          isOpen: isOpen(item),
          isActive: isActive(item),
        }}
        index={index}
        extra={renderListItemExtra(item)}
        extra2={renderListItemExtra2(item)}
        onClick={(e) => handleFileClick(e, index)}
        onMouseDown={(e: React.MouseEvent, name: string) => {
          setSelectionOnMouseDown(window.getSelection()?.toString() ?? "");
          if (e.button === 1) {
            // middle mouse click
            actions?.close_tab(path_to_file(effective_current_path, name));
          }
        }}
        itemStyle={fileItemStyle(age ?? 0, mask)}
        onPublic={() => showFileSharingDialog(directoryFiles[index])}
        selected={isSelected}
        showCheckbox={
          mode === "select" ||
          checked_files?.size > 0 ||
          showCheckboxIndex === index
        }
        setShowCheckboxIndex={setShowCheckboxIndex}
        onChecked={(nextState: boolean) => {
          toggleSelected(index, item.name, nextState);
        }}
        checked_files={checked_files}
        isStarred={isStarred}
        onStar={(starState: boolean) => {
          const normalizedPath =
            item.isDir && !fullPath.endsWith("/") ? `${fullPath}/` : fullPath;
          manageStarredFiles.setStarredPath(normalizedPath, starState);
        }}
        currentPath={effective_current_path}
        dragPaths={
          checked_files.includes(fullPath)
            ? checked_files.toArray()
            : [fullPath]
        }
      />
    );
  }

  function renderLoadingOrStartProject(): React.JSX.Element {
    if (projectIsRunning) {
      return <Loading theme="medium" transparent />;
    } else if (shouldShowStartProjectWarning) {
      return (
        <Alert
          type="info"
          banner
          showIcon={false}
          style={{ padding: FLYOUT_PADDING, margin: 0 }}
          description={
            <FormattedMessage
              id="project.explorer.start_project.warning"
              defaultMessage={
                "To see the files in this directory, you must <a>start this project</a>."
              }
              values={{
                a: (chunks) => (
                  <a
                    onClick={(e) => {
                      e.preventDefault();
                      redux.getActions("projects").start_project(project_id);
                    }}
                  >
                    {chunks}
                  </a>
                ),
              }}
            />
          }
        />
      );
    } else if (hostUnavailable) {
      return (
        <Alert
          type="warning"
          banner
          showIcon={false}
          style={{ padding: FLYOUT_PADDING, margin: 0 }}
          description={
            <>
              This project is assigned to {assignedHostLabel}, which is
              unavailable ({hostUnavailableReason}). You can wait, or move this
              project to an available host.
              <div style={{ marginTop: "8px" }}>
                <MoveProject
                  project_id={project_id}
                  size="small"
                  label="Move Project"
                  showHostName={false}
                />
              </div>
            </>
          }
        />
      );
    } else {
      return (
        <Alert
          type="warning"
          banner
          showIcon={false}
          style={{ padding: FLYOUT_PADDING, margin: 0 }}
          description={
            <>
              In order to see the files in this directory, you have to{" "}
              <a
                onClick={() => {
                  redux.getActions("projects").start_project(project_id);
                }}
              >
                start this project
              </a>
              .
            </>
          }
        />
      );
    }
  }

  function renderListing(): React.JSX.Element {
    if (effectiveListing == null) {
      return renderLoadingOrStartProject();
    }

    return (
      <FileDndProvider
        project_id={project_id}
        onUserFilesystemChange={allowNextListingUpdate}
      >
        <StatefulVirtuoso
          ref={virtuosoRef}
          cacheId={`${project_id}::flyout::files::${effective_current_path}`}
          style={{}}
          increaseViewportBy={10}
          onMouseLeave={() => setShowCheckboxIndex(null)}
          totalCount={directoryFiles.length}
          initialTopMostItemIndex={0}
          itemContent={(index) => {
            const file = directoryFiles[index];
            if (file == null) {
              // shouldn't happen
              return <div key={index} style={{ height: "1px" }}></div>;
            }
            return renderListItem(index, file);
          }}
        />
      </FileDndProvider>
    );
  }

  function clearAllSelections(switchMode) {
    if (switchMode) setMode("open");
    setPrevSelected(null);
    actions?.set_all_files_unchecked();
  }

  function selectAllFiles() {
    actions?.set_file_list_checked(
      directoryFiles
        .filter((f) => f.name !== "..")
        .map((f) => path_to_file(effective_current_path, f.name)),
    );
  }

  return (
    <div
      ref={rootRef}
      style={{ flex: "1 0 auto", flexDirection: "column", display: "flex" }}
    >
      {!suppressRoutingError && !shouldShowStartProjectWarning && (
        <ShowError error={effectiveError} setError={effectiveRefresh} />
      )}
      <FilesHeader
        activeFile={activeFile}
        getFile={getFile}
        activeFileSort={activeFileSort}
        checked_files={checked_files}
        directoryFiles={directoryFiles}
        disableUploads={disableUploads}
        handleSearchChange={handleSearchChange}
        isEmpty={isEmpty}
        open={open}
        refInput={refInput}
        scrollIdx={scrollIdx}
        setScrollIdx={setScrollIdx}
        setScrollIdxHide={setScrollIdxHide}
        setSearchState={setSearchState}
        showFileSharingDialog={showFileSharingDialog}
        virtuosoRef={virtuosoRef}
        modeState={[mode, setMode]}
        clearAllSelections={clearAllSelections}
        selectAllFiles={selectAllFiles}
        publicFiles={publicFiles}
        refreshBackups={refreshBackups}
        currentPath={effective_current_path}
        onNavigate={navigateFlyout}
        setActiveFileSort={(sort) => {
          setActiveFileSort(sort);
          allowNextListingUpdate();
        }}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        typeFilterOptions={typeFilterOptions}
        hasPendingUpdate={hasPendingListingUpdate}
        onRefreshListing={flushListingUpdate}
        onTerminalCommand={allowNextListingUpdate}
      />
      {!lite && <DiskUsage project_id={project_id} style={{ margin: "5px" }} />}
      {disableUploads ? (
        renderListing()
      ) : (
        <FileUploadWrapper
          project_id={project_id}
          dest_path={effective_current_path}
          event_handlers={{
            complete: () => allowNextListingUpdate(),
          }}
          style={{
            flex: "1 0 auto",
            display: "flex",
            flexDirection: "column",
          }}
          className="smc-vfill"
        >
          {renderListing()}
        </FileUploadWrapper>
      )}
      <FilesBottom
        project_id={project_id}
        checked_files={checked_files}
        activeFile={activeFile}
        directoryFiles={directoryFiles}
        modeState={[mode, setMode]}
        projectIsRunning={projectIsRunning}
        rootHeightPx={rootHeightPx}
        clearAllSelections={clearAllSelections}
        selectAllFiles={selectAllFiles}
        open={open}
        showFileSharingDialog={showFileSharingDialog}
        getFile={getFile}
        publicFiles={publicFiles}
        refreshBackups={refreshBackups}
        currentPath={effective_current_path}
        onNavigate={navigateFlyout}
      />
      {modal}
    </div>
  );
}
