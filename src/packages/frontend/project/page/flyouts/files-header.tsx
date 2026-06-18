/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, InputRef, Space, Tag } from "antd";
import immutable from "immutable";
import { useIntl } from "react-intl";
import { VirtuosoHandle } from "react-virtuoso";
import {
  CSS,
  React,
  redux,
  useAsyncEffect,
  useAccountOtherSetting,
  useEffect,
  useIsMountedRef,
  usePrevious,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  DropdownMenu,
  Icon,
  Text,
  Tooltip,
  type MenuItems,
  ErrorDisplay,
} from "@cocalc/frontend/components";
import { FileUploadWrapper } from "@cocalc/frontend/file-upload";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { SearchHistoryDropdown } from "@cocalc/frontend/project/explorer/search-history-dropdown";
import { useExplorerSearchHistory } from "@cocalc/frontend/project/explorer/use-search-history";
import { RefreshButton } from "@cocalc/frontend/project/explorer/refresh-button";
import {
  DirectoryListing,
  DirectoryListingEntry,
} from "@cocalc/frontend/project/explorer/types";
import {
  extractAgentPrompt,
  isAgentMode,
  isTerminalMode,
  TypeFilterLabel,
} from "@cocalc/frontend/project/explorer/file-listing/utils";
import { TerminalModeDisplay } from "@cocalc/frontend/project/explorer/file-listing/terminal-mode-display";
import { useAvailableFeatures } from "@cocalc/frontend/project/use-available-features";
import {
  LAUNCHER_SETTINGS_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  getAccountLauncherPrefs,
  getEffectiveLauncher,
  getSiteLauncherDefaults,
  updateAccountLauncherPrefs,
} from "@cocalc/frontend/project/new/launcher-preferences";
import { LauncherCustomizeModal } from "@cocalc/frontend/project/new/launcher-customize-modal";
import { QuickCreateDropdown } from "@cocalc/frontend/project/new/quick-create-dropdown";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { PLATFORM_MODE_CLOUD } from "@cocalc/util/db-schema/site-defaults";
import { separate_file_extension, strictMod } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { FIX_BORDER } from "../common";
import { DEFAULT_EXT, FLYOUT_PADDING } from "./consts";
import type { ActiveFileSort } from "./files";
import { FilesSelectedControls } from "./files-controls";
import { FilesSelectButtons } from "./files-select-extra";
import { FlyoutClearFilter, FlyoutFilterWarning } from "./filter-warning";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { BACKUPS } from "@cocalc/util/consts/backups";
import { lite } from "@cocalc/frontend/lite";
import { dirname } from "path";
import { submitNavigatorPromptToCurrentThread } from "@cocalc/frontend/project/new/navigator-intents";

function searchToFilename(search: string): string {
  if (search.endsWith(" ")) {
    return search.trim(); // base name, without extension
  }
  search = search.trim();
  if (search === "") return "";
  // if last character is "/" return the search string
  if (search.endsWith("/")) return search;
  if (search.endsWith(".")) return `${search}${DEFAULT_EXT}`;
  const { ext } = separate_file_extension(search);
  if (ext.length > 0) return search;
  if (ext === "") return `${search}.${DEFAULT_EXT}`;
  return `${search}.${DEFAULT_EXT}`;
}

function toFlyoutPathFromExecCwd(payload: string, homePath: string): string {
  if (!payload.startsWith("/")) return payload;

  for (const root of [BACKUPS, SNAPSHOTS]) {
    const absoluteRoot = `${homePath}/${root}`;
    if (payload === absoluteRoot) {
      return root;
    }
    if (payload.startsWith(`${absoluteRoot}/`)) {
      return payload.slice(homePath.length + 1);
    }
  }

  return payload;
}

interface Props {
  activeFileSort: ActiveFileSort;
  disableUploads: boolean;
  handleSearchChange: (search: string) => void;
  isEmpty: boolean;
  open: (e: React.KeyboardEvent | React.MouseEvent, idx: number) => void;
  refInput: React.RefObject<InputRef>;
  scrollIdx: number | null;
  setScrollIdx: (idx: number | null) => void;
  setScrollIdxHide: (hide: boolean) => void;
  setSearchState: (search: string) => void;
  virtuosoRef: React.RefObject<VirtuosoHandle>;
  checked_files: immutable.Set<string>;
  directoryFiles: DirectoryListing;
  getFile: (path: string) => DirectoryListingEntry | undefined;
  activeFile: DirectoryListingEntry | null;
  modeState: ["open" | "select", (mode: "open" | "select") => void];
  clearAllSelections: (switchMode: boolean) => void;
  selectAllFiles: () => void;
  refreshBackups?: () => void;
  currentPath: string;
  onNavigate: (path: string) => void;
  setActiveFileSort: (sort: ActiveFileSort) => void;
  typeFilter: string | null;
  setTypeFilter: (filter: string | null) => void;
  typeFilterOptions: string[];
  hasPendingUpdate?: boolean;
  onRefreshListing?: () => void;
  onTerminalCommand?: () => void;
}

export function FilesHeader({
  activeFileSort,
  disableUploads,
  handleSearchChange,
  isEmpty,
  open,
  refInput,
  scrollIdx,
  setScrollIdx,
  setScrollIdxHide,
  setSearchState,
  virtuosoRef,
  checked_files,
  directoryFiles,
  getFile,
  activeFile,
  modeState,
  selectAllFiles,
  clearAllSelections,
  refreshBackups,
  currentPath,
  onNavigate,
  setActiveFileSort,
  typeFilter,
  setTypeFilter,
  typeFilterOptions,
  hasPendingUpdate,
  onRefreshListing,
  onTerminalCommand,
}: Readonly<Props>): React.JSX.Element {
  const intl = useIntl();

  const {
    isRunning: projectIsRunning,
    project_id,
    actions,
  } = useProjectContext();

  const [mode, setMode] = modeState;

  const uploadClassName = `upload-button-flyout-${project_id}`;
  const platformMode = useTypedRedux("customize", "platform_mode");
  const launcherSettings = useAccountOtherSetting(LAUNCHER_SETTINGS_KEY);
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const file_search = useTypedRedux({ project_id }, "file_search") ?? "";
  const hidden = useTypedRedux({ project_id }, "show_hidden");
  const file_creation_error = useTypedRedux(
    { project_id },
    "file_creation_error",
  );
  const {
    history,
    initialized: historyInitialized,
    addHistoryEntry,
  } = useExplorerSearchHistory(project_id);
  const effective_current_path = currentPath;
  const homePath = getProjectHomeDirectory(project_id);
  const isReadonlyVirtualPath =
    effective_current_path === SNAPSHOTS ||
    effective_current_path?.startsWith(`${SNAPSHOTS}/`) ||
    effective_current_path === BACKUPS ||
    effective_current_path?.startsWith(`${BACKUPS}/`);

  const [highlighNothingFound, setHighlighNothingFound] = React.useState(false);
  const [historyMode, setHistoryMode] = React.useState(false);
  const [historyIndex, setHistoryIndex] = React.useState(0);
  const [termError, setTermError] = React.useState<string | undefined>();
  const [termStdout, setTermStdout] = React.useState<string | undefined>();
  const termIdRef = React.useRef(0);
  const isMountedRef = useIsMountedRef();
  const file_search_prev = usePrevious(file_search);
  const availableFeatures = useAvailableFeatures(project_id);
  const [showCustomizeModal, setShowCustomizeModal] = React.useState(false);
  const siteLauncherDefaults = getSiteLauncherDefaults(site_launcher_quick);
  const accountLauncherPrefs = getAccountLauncherPrefs(launcherSettings);
  const mergedLauncher = getEffectiveLauncher({
    accountPrefs: accountLauncherPrefs,
    siteDefaults: siteLauncherDefaults,
  });

  useEffect(() => {
    if (!highlighNothingFound) return;
    if (!isEmpty || file_search != file_search_prev || file_search === "") {
      setHighlighNothingFound(false);
    }
  }, [isEmpty, file_search, highlighNothingFound]);

  // disable highlightNothingFound shortly after being set
  useAsyncEffect(async () => {
    if (!highlighNothingFound) return;
    await new Promise((resolve) => setTimeout(resolve, 333));
    setHighlighNothingFound(false);
  }, [highlighNothingFound]);

  useEffect(() => {
    if (!historyMode) return;
    if (history.length === 0) {
      setHistoryMode(false);
      setHistoryIndex(0);
      return;
    }
    if (historyIndex >= history.length) {
      setHistoryIndex(history.length - 1);
    }
  }, [history, historyIndex, historyMode]);

  function doScroll(dx: -1 | 1) {
    const nextIdx = strictMod(
      scrollIdx == null ? (dx === 1 ? 0 : -1) : scrollIdx + dx,
      directoryFiles.length,
    );
    setScrollIdx(nextIdx);
    virtuosoRef.current?.scrollToIndex({
      index: nextIdx,
      align: "center",
    });
  }

  async function createFileOrFolder() {
    const fn = searchToFilename(file_search);
    await actions?.createFile({
      name: fn,
      current_path: effective_current_path,
    });
  }

  function createQuickFile(ext: string): void {
    if (file_search.length === 0) {
      actions?.ask_filename(ext);
      return;
    }
    actions?.createFile({
      name: file_search,
      ext,
      current_path: effective_current_path,
    });
    setSearchState("");
  }

  function createQuickFolder(): void {
    if (file_search.length === 0) {
      actions?.ask_filename("/");
      return;
    }
    actions?.createFolder({
      name: file_search,
      current_path: effective_current_path,
      switch_over: true,
    });
    setSearchState("");
  }

  function saveUserLauncherPrefs(prefs: any | null) {
    const next = updateAccountLauncherPrefs(launcherSettings, prefs);
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
  }

  function applyHistorySelection(idx?: number): void {
    const value = history[idx ?? historyIndex];
    setHistoryMode(false);
    setHistoryIndex(0);
    if (value == null) return;
    setScrollIdx(null);
    handleSearchChange(value);
  }

  function runTerminalCommand(command: string): void {
    const input = command.trim();
    if (!input) return;

    setTermError(undefined);
    setTermStdout(undefined);
    onTerminalCommand?.();

    const id = ++termIdRef.current;
    const input0 = input + '\necho $HOME "`pwd`"';

    webapp_client.exec({
      project_id,
      command: input0,
      timeout: 10,
      max_output: 100000,
      bash: true,
      path: effective_current_path,
      err_on_exit: false,
      filesystem: true,
      cb(err, output) {
        if (id !== termIdRef.current || !isMountedRef.current) return;
        if (err) {
          setTermError(JSON.stringify(err));
          return;
        }

        if (output.stdout) {
          let s = output.stdout.trim();
          let i = s.lastIndexOf("\n");
          if (i === -1) {
            output.stdout = "";
          } else {
            s = s.slice(i + 1);
            output.stdout = output.stdout.slice(0, i);
          }
          i = s.indexOf(" ");
          const full_path = s.slice(i + 1);
          if (full_path.slice(0, i) === s.slice(0, i)) {
            const path = toFlyoutPathFromExecCwd(s.slice(2 * i + 2), homePath);
            onNavigate(path);
          }
        }
        if (!output.stderr) {
          actions?.log({ event: "termInSearch", input });
        }
        setTermError(output.stderr || undefined);
        setTermStdout(output.stdout || undefined);
        if (!output.stderr) {
          setSearchState("");
        }
      },
    });
  }

  async function runAgentPrompt(rawInput: string): Promise<void> {
    const prompt = extractAgentPrompt(rawInput);
    if (!prompt) return;

    setTermError(undefined);
    setTermStdout(undefined);
    onTerminalCommand?.();

    const sent = await submitNavigatorPromptToCurrentThread({
      project_id,
      prompt,
      visiblePrompt: prompt,
      path: effective_current_path,
      tag: "intent:miniterm-agent",
    });
    if (sent) {
      setSearchState("");
      return;
    }
    setTermError("Unable to send prompt to the agent.");
  }

  function filterKeyHandler(e: React.KeyboardEvent) {
    if (e.code === "ArrowUp") {
      if (!historyMode && historyInitialized && history.length > 0) {
        setHistoryMode(true);
        setHistoryIndex(0);
        return;
      }
      if (historyMode) {
        setHistoryIndex((idx) => Math.max(idx - 1, 0));
        return;
      }
      doScroll(-1);
      return;
    }

    if (e.code === "ArrowDown") {
      if (historyMode) {
        setHistoryIndex((idx) => Math.min(idx + 1, history.length - 1));
        return;
      }
      doScroll(1);
      return;
    }

    // left arrow key: go up a directory
    if (e.code === "ArrowLeft") {
      if (effective_current_path !== "/") {
        const normalizedPath = effective_current_path.replace(/^\/+/, "");
        if (normalizedPath.startsWith(".")) {
          onNavigate(normalizedPath.split("/").slice(0, -1).join("/"));
        } else {
          onNavigate(dirname(effective_current_path));
        }
      }
      return;
    }

    // return key pressed
    if (e.code === "Enter") {
      if (historyMode) {
        applyHistorySelection();
        return;
      }
      if (isTerminalMode(file_search)) {
        const command = file_search.slice(1);
        if (command.trim().length > 0) {
          addHistoryEntry(file_search);
        }
        runTerminalCommand(command);
        return;
      }
      if (isAgentMode(file_search)) {
        if (extractAgentPrompt(file_search).length > 0) {
          addHistoryEntry(file_search);
        }
        void runAgentPrompt(file_search);
        return;
      }
      if (scrollIdx != null) {
        addHistoryEntry(file_search);
        open(e, scrollIdx);
        setScrollIdx(null);
      } else if (file_search != "") {
        if (!isEmpty) {
          addHistoryEntry(file_search);
          setSearchState("");
          open(e, 0);
        } else {
          if (e.shiftKey && !isReadonlyVirtualPath) {
            // only if shift is pressed as well, create a file or folder
            // this avoids accidentally creating jupyter notebooks (the default file type)
            createFileOrFolder();
            setSearchState("");
          } else {
            // we change a state, such that at least something happens if user hits return
            setHighlighNothingFound(true);
          }
        }
      }
      return;
    }

    // if esc key is pressed, clear search and reset scroll index
    if (e.key === "Escape") {
      if (historyMode) {
        setHistoryMode(false);
        setHistoryIndex(0);
        return;
      }
      setTermError(undefined);
      setTermStdout(undefined);
      if (file_search) {
        addHistoryEntry(file_search);
      }
      handleSearchChange("");
    }
  }

  function wrapDropzone(children: React.JSX.Element): React.JSX.Element {
    if (disableUploads) return children;
    return (
      <FileUploadWrapper
        project_id={project_id}
        dest_path={effective_current_path}
        config={{ clickable: `.${uploadClassName}` }}
        event_handlers={{
          sending: () => onRefreshListing?.(),
          complete: () => onRefreshListing?.(),
        }}
        className="smc-vfill"
      >
        {children}
      </FileUploadWrapper>
    );
  }

  function setSort(name: string): void {
    const isActive = activeFileSort.column_name === name;
    setActiveFileSort({
      column_name: name,
      is_descending: isActive ? !activeFileSort.is_descending : false,
    });
  }

  function renderSortMenuItem(
    name: string,
    label: React.JSX.Element | string,
  ): MenuItems[number] {
    const isActive = activeFileSort.column_name === name;
    return {
      key: `sort-${name}`,
      label: (
        <span style={{ whiteSpace: "nowrap" }}>
          {isActive ? (
            <Icon name="check" style={{ marginRight: 6 }} />
          ) : (
            <span
              style={{ display: "inline-block", width: 14, marginRight: 6 }}
            />
          )}
          {label}
          {isActive ? (
            <Icon
              name={activeFileSort.is_descending ? "caret-up" : "caret-down"}
              style={{ marginLeft: 6, color: COLORS.GRAY_M }}
            />
          ) : undefined}
        </span>
      ),
      onClick: () => setSort(name),
    };
  }

  function renderViewMenuItems(): MenuItems {
    const typeItems: MenuItems = [
      {
        key: "type-all",
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            {typeFilter == null ? (
              <Icon name="check" style={{ marginRight: 6 }} />
            ) : (
              <span
                style={{ display: "inline-block", width: 14, marginRight: 6 }}
              />
            )}
            All file types
          </span>
        ),
        onClick: () => setTypeFilter(null),
      },
      ...typeFilterOptions.map((ext) => ({
        key: `type-${ext}`,
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            {typeFilter === ext ? (
              <Icon name="check" style={{ marginRight: 6 }} />
            ) : (
              <span
                style={{ display: "inline-block", width: 14, marginRight: 6 }}
              />
            )}
            <TypeFilterLabel ext={ext} />
          </span>
        ),
        onClick: () => setTypeFilter(ext),
      })),
    ];

    return [
      {
        key: "sort",
        label: "Sort by",
        children: [
          renderSortMenuItem(
            "starred",
            <span>
              <Icon name="star-filled" style={{ marginRight: 4 }} />
              Starred
            </span>,
          ),
          renderSortMenuItem("name", "Name"),
          renderSortMenuItem("size", "Size"),
          renderSortMenuItem("time", "Time"),
          renderSortMenuItem("type", "Type"),
        ],
      },
      {
        key: "type",
        label: typeFilter == null ? "File type" : `File type: ${typeFilter}`,
        children: typeItems,
      },
      { type: "divider" },
      {
        key: "hidden",
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon
              name={hidden ? "eye" : "eye-slash"}
              style={{ marginRight: 6 }}
            />
            {hidden ? "Hide hidden files" : "Show hidden files"}
          </span>
        ),
        onClick: () => actions?.setState({ show_hidden: !hidden }),
      },
    ];
  }

  function renderMoreMenuItems(): MenuItems {
    const commandItems: MenuItems = [
      {
        key: "terminal-command",
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon name="terminal" style={{ marginRight: 6 }} />
            Terminal command
          </span>
        ),
        onClick: () => {
          setSearchState("!");
          setTimeout(() => refInput.current?.focus(), 0);
        },
      },
      {
        key: "agent-prompt",
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon name="magic" style={{ marginRight: 6 }} />
            Agent prompt
          </span>
        ),
        onClick: () => {
          setSearchState("/");
          setTimeout(() => refInput.current?.focus(), 0);
        },
      },
    ];

    const recoveryItems: MenuItems = lite
      ? []
      : [
          { type: "divider" },
          {
            key: "snapshots-open",
            label: "Browse Snapshots",
            onClick: () => {
              onNavigate(SNAPSHOTS);
            },
          },
          {
            key: "snapshots-config",
            label: "Configure Snapshots",
            onClick: () => {
              onNavigate(SNAPSHOTS);
              actions?.setState({ open_snapshot_schedule: true });
            },
          },
          {
            key: "snapshots-create",
            label: "Create Snapshot",
            onClick: () => {
              onNavigate(SNAPSHOTS);
              actions?.setState({ open_create_snapshot: true });
            },
          },
          {
            key: "snapshots-restore",
            label: "Restore Snapshot",
            onClick: () => {
              onNavigate(SNAPSHOTS);
              actions?.setState({
                open_restore_snapshot: true,
              });
            },
          },
          { type: "divider" },
          {
            key: "backups-open",
            label: "Browse Backups",
            onClick: () => {
              onNavigate(BACKUPS);
            },
          },
          {
            key: "backups-config",
            label: "Configure Backups",
            onClick: () => {
              onNavigate(BACKUPS);
              actions?.setState({ open_backup_schedule: true });
            },
          },
          {
            key: "backups-create",
            label: "Create Backup",
            onClick: () => {
              onNavigate(BACKUPS);
              actions?.setState({ open_create_backup: true });
            },
          },
        ];

    return [
      ...commandItems,
      ...recoveryItems,
      ...(platformMode === PLATFORM_MODE_CLOUD
        ? [
            { type: "divider" } as const,
            {
              key: "clone-project",
              label: <CloneProject project_id={project_id} flyout />,
            },
          ]
        : []),
    ];
  }

  function renderActiveViewFilters() {
    const tags: React.JSX.Element[] = [];
    if (activeFileSort.column_name !== "name" || activeFileSort.is_descending) {
      tags.push(
        <Tag
          key="sort"
          closable
          onClose={(e) => {
            e.preventDefault();
            setActiveFileSort({ column_name: "name", is_descending: false });
          }}
        >
          Sort: {activeFileSort.column_name}
        </Tag>,
      );
    }
    if (typeFilter != null) {
      tags.push(
        <Tag
          key="type"
          closable
          onClose={(e) => {
            e.preventDefault();
            setTypeFilter(null);
          }}
        >
          Type: {typeFilter}
        </Tag>,
      );
    }
    if (hidden) {
      tags.push(
        <Tag
          key="hidden"
          closable
          onClose={(e) => {
            e.preventDefault();
            actions?.setState({ show_hidden: false });
          }}
        >
          Hidden files
        </Tag>,
      );
    }
    if (tags.length === 0) return null;
    return (
      <Space size={0} wrap style={{ lineHeight: 1 }}>
        {tags}
      </Space>
    );
  }

  function renderFileCreationError() {
    if (!file_creation_error) return;
    return (
      <ErrorDisplay
        banner
        error={file_creation_error}
        componentStyle={{
          margin: 0,
          maxHeight: "200px",
        }}
        onClose={(): void => {
          actions?.setState({ file_creation_error: "" });
        }}
      />
    );
  }

  function renderTerminalOutput(
    text: string | undefined,
    { color, onClose }: { color?: string; onClose: () => void },
  ): React.JSX.Element | undefined {
    if (!text) return;
    return (
      <pre
        style={{
          margin: 0,
          padding: FLYOUT_PADDING,
          maxHeight: "200px",
          overflow: "auto",
          fontSize: "12px",
          position: "relative",
          ...(color ? { color } : undefined),
        }}
      >
        <a
          onClick={onClose}
          style={{
            position: "sticky",
            top: 0,
            right: 0,
            display: "block",
            width: "fit-content",
            marginLeft: "auto",
            color: COLORS.GRAY_M,
            background: "white",
            padding: "0 5px",
            zIndex: 1,
          }}
        >
          <Icon name="times" />
        </a>
        {text}
      </pre>
    );
  }

  function activeFilterWarning() {
    if (file_search === "" || isTerminalMode(file_search)) return;
    if (!isEmpty) {
      return (
        <FlyoutFilterWarning filter={file_search} setFilter={setSearchState} />
      );
    }
  }

  function createFileIfNotExists() {
    if (typeFilter != null && file_search === "" && isEmpty) {
      const style: CSS = {
        padding: FLYOUT_PADDING,
        margin: 0,
      };
      return (
        <Alert
          type="info"
          banner
          showIcon={false}
          style={style}
          description={
            <>
              <Button
                size="small"
                type="text"
                style={{ float: "right", color: COLORS.GRAY_M }}
                onClick={() => setTypeFilter(null)}
                icon={<Icon name="close-circle-filled" />}
              />
              No files or folders match the current type filter.
            </>
          }
        />
      );
    }

    if (
      file_search === "" ||
      !isEmpty ||
      isTerminalMode(file_search) ||
      isAgentMode(file_search)
    )
      return;

    if (isReadonlyVirtualPath) {
      const style: CSS = {
        padding: FLYOUT_PADDING,
        margin: 0,
        ...(highlighNothingFound ? { fontWeight: "bold" } : undefined),
      };
      return (
        <Alert
          type="info"
          banner
          showIcon={false}
          style={style}
          description={
            <>
              <div>
                <FlyoutClearFilter setFilter={setSearchState} />
                No files or folders match the current filter.
              </div>
            </>
          }
        />
      );
    }

    const what = file_search.trim().endsWith("/") ? "directory" : "file";
    const style: CSS = {
      padding: FLYOUT_PADDING,
      margin: 0,
      ...(highlighNothingFound ? { fontWeight: "bold" } : undefined),
    };
    return (
      <Alert
        type="info"
        banner
        showIcon={false}
        style={style}
        description={
          <>
            <div>
              <FlyoutClearFilter setFilter={setSearchState} />
              No files match the current filter.
            </div>
            <div>
              Hit <Text code>Shift+Return</Text> to create the {what}{" "}
              <Text code>{searchToFilename(file_search)}</Text>
            </div>
          </>
        }
      />
    );
  }

  function renderFileControls() {
    if (checked_files.size === 0) return null;

    return (
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: FLYOUT_PADDING,
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <FilesSelectedControls
            project_id={project_id}
            checked_files={checked_files}
            directoryFiles={directoryFiles}
            open={open}
            getFile={getFile}
            mode="top"
            activeFile={activeFile}
            refreshBackups={refreshBackups}
            showActions={false}
          />
          <div
            aria-hidden={!hasPendingUpdate}
            style={{
              display: "inline-flex",
              visibility: hasPendingUpdate ? "visible" : "hidden",
              pointerEvents: hasPendingUpdate ? undefined : "none",
            }}
          >
            <RefreshButton onClick={onRefreshListing} />
          </div>
        </div>
        <FilesSelectButtons
          setMode={setMode}
          checked_files={checked_files}
          mode={mode}
          selectAllFiles={selectAllFiles}
          clearAllSelections={clearAllSelections}
        />
      </div>
    );
  }

  return (
    <>
      <Space
        orientation="vertical"
        style={{
          flex: "0 0 auto",
          width: "100%",
          paddingBottom: FLYOUT_PADDING,
          paddingRight: FLYOUT_PADDING,
        }}
      >
        {wrapDropzone(
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: FLYOUT_PADDING,
              width: "100%",
            }}
          >
            <div style={{ flex: "1", position: "relative" }}>
              <Input
                ref={refInput}
                placeholder="Search files"
                size="small"
                value={file_search}
                onKeyDown={filterKeyHandler}
                onChange={(e) => {
                  setHistoryMode(false);
                  setHistoryIndex(0);
                  handleSearchChange(e.target.value);
                }}
                onFocus={() => setScrollIdxHide(false)}
                onBlur={() => {
                  setScrollIdxHide(true);
                  setHistoryMode(false);
                  setHistoryIndex(0);
                }}
                style={{ width: "100%" }}
                allowClear
                prefix={<Icon name="search" />}
              />
              {historyMode && history.length > 0 && (
                <SearchHistoryDropdown
                  history={history}
                  historyIndex={historyIndex}
                  setHistoryIndex={setHistoryIndex}
                  onSelect={applyHistorySelection}
                  style={{ top: "32px" }}
                />
              )}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: FLYOUT_PADDING,
                flexWrap: "wrap",
              }}
            >
              <Space size="small" wrap>
                <Tooltip
                  title={intl.formatMessage(labels.new_tooltip)}
                  placement="bottom"
                >
                  <span>
                    <QuickCreateDropdown
                      size="small"
                      quickCreateIds={mergedLauncher.quickCreate}
                      availableFeatures={availableFeatures}
                      onCreateFile={createQuickFile}
                      onCreateFolder={createQuickFolder}
                      onCustomize={() => setShowCustomizeModal(true)}
                    />
                  </span>
                </Tooltip>
                <Tooltip
                  title={intl.formatMessage(labels.upload_tooltip)}
                  placement="bottom"
                >
                  <Button
                    className={uploadClassName}
                    size="small"
                    disabled={!projectIsRunning || disableUploads}
                  >
                    <Icon name={"upload"} /> Upload
                  </Button>
                </Tooltip>
                <FilesSelectButtons
                  setMode={setMode}
                  checked_files={checked_files}
                  mode={mode}
                  selectAllFiles={selectAllFiles}
                  clearAllSelections={clearAllSelections}
                />
                <DropdownMenu
                  button
                  showDown
                  size="small"
                  items={renderViewMenuItems()}
                  title={
                    <>
                      <Icon name="eye" /> View
                    </>
                  }
                />
                <DropdownMenu
                  button
                  showDown
                  size="small"
                  items={renderMoreMenuItems()}
                  title={
                    <>
                      <Icon name="ellipsis" /> More
                    </>
                  }
                />
              </Space>
              {hasPendingUpdate ? (
                <RefreshButton onClick={onRefreshListing} />
              ) : null}
            </div>
            {renderActiveViewFilters()}
          </div>,
        )}
        {renderFileControls()}
      </Space>
      <Space
        orientation="vertical"
        style={{
          flex: "0 0 auto",
          borderBottom: FIX_BORDER,
        }}
      >
        {isTerminalMode(file_search) && (
          <TerminalModeDisplay style={{ padding: FLYOUT_PADDING, margin: 0 }} />
        )}
        {renderTerminalOutput(termError, {
          color: COLORS.FG_RED,
          onClose: () => setTermError(undefined),
        })}
        {renderTerminalOutput(termStdout, {
          onClose: () => setTermStdout(undefined),
        })}
        {activeFilterWarning()}
        {createFileIfNotExists()}
        {renderFileCreationError()}
      </Space>
      <LauncherCustomizeModal
        open={showCustomizeModal}
        onClose={() => setShowCustomizeModal(false)}
        initialQuickCreate={mergedLauncher.quickCreate}
        onSave={saveUserLauncherPrefs}
      />
    </>
  );
}
