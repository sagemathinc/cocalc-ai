/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Tabs for the open files in a project.
*/

import type { TabsProps } from "antd";
import { Button, Divider, Select, Tabs } from "antd";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import {
  renderTabBar,
  SortableTabs,
  useItemContext,
  useSortable,
} from "@cocalc/frontend/components/sortable-tabs";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { labels } from "@cocalc/frontend/i18n";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import { useRecentFiles } from "@cocalc/frontend/projects/util";
import { EDITOR_PREFIX, path_split, path_to_tab } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { file_tab_labels } from "../file-tab-labels";
import { useProjectContext } from "../context";
import { generatedWorkspaceChatLabel } from "../workspaces/chat-display";
import { reorderVisibleSubset } from "./file-tab-order";
import { FileTab } from "./file-tab";
import { FILE_TAB_STRIP_ATTRIBUTE } from "./keyboard-navigation";

const MIN_WIDTH = 48;
const FILE_TABS_MODE_KEY = "cocalc:file-tabs-mode";

type FileTabsMode = "tabs" | "dropdown";

function getStoredFileTabsMode(): FileTabsMode {
  const stored = get_local_storage(FILE_TABS_MODE_KEY);
  return stored === "tabs" || stored === "dropdown" ? stored : "tabs";
}

function storeFileTabsMode(mode: FileTabsMode): void {
  set_local_storage(FILE_TABS_MODE_KEY, mode);
}

function Label({ path, project_id, label, onClose }) {
  const { width } = useItemContext();
  const { active } = useSortable({ id: project_id });
  return (
    <FileTab
      key={path}
      project_id={project_id}
      path={path}
      label={label}
      noPopover={active != null}
      style={{
        ...(width != null
          ? { width: Math.max(MIN_WIDTH, width + 15), marginRight: "-10px" }
          : undefined),
      }}
      onClose={onClose}
    />
  );
}

// This mapping back and forth is needed because of, I guess, a bug
// in antd, where the key can't include a double quote.  This was
// the closest thing in the antd bug tracker:
//   https://github.com/ant-design/ant-design/issues/33928
// I hope there are no other special characters to exclude.
// This doesn't impact projects since they use the project_id.
// Note the "unused unicode character"; we use
// this same trick in various places throughout cocalc.
function pathToKey(s: string): string {
  if (s.includes("\uFE35")) {
    throw Error(`invalid path: ${JSON.stringify(s)}`);
  }
  return s.replace(/"/g, "\uFE35");
}

function keyToPath(s: string): string {
  return s.replace(/\uFE35/g, '"');
}

export default function FileTabs({ openFiles, project_id, activeTab }) {
  const actions = useActions({ project_id });
  const intl = useIntl();
  const { workspaces } = useProjectContext();
  const project_log = useTypedRedux({ project_id }, "project_log");
  const project_log_loading = useTypedRedux(
    { project_id },
    "project_log_loading",
  );
  const [mode, setMode] = useState<FileTabsMode>(getStoredFileTabsMode);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const paths: string[] = [];
  const keys: string[] = [];
  const visibleOpenFiles = workspaces.filterPaths(
    openFiles?.toJS?.() ?? openFiles ?? [],
  );

  visibleOpenFiles.map((path) => {
    if (path == null) {
      throw Error(
        "BUG -- each entry in openFiles must be defined -- " +
          JSON.stringify(openFiles.toJS()),
      );
    }
    paths.push(path);
    keys.push(pathToKey(path));
  });

  const activePath = activeTab.startsWith(EDITOR_PREFIX)
    ? activeTab.slice(EDITOR_PREFIX.length)
    : "";

  useEffect(() => {
    if (mode !== "dropdown") return;
    actions?.refresh_project_log?.();
  }, [actions, mode]);

  function setTabsMode(nextMode: FileTabsMode): void {
    setMode(nextMode);
    storeFileTabsMode(nextMode);
    if (nextMode === "tabs") {
      setDropdownOpen(false);
      setSearchValue("");
    }
  }

  function closeVisibleTab(path: string): void {
    if (actions == null) return;
    if (path !== activePath || workspaces.selection.kind !== "workspace") {
      actions.close_tab(path);
      return;
    }
    const current = workspaces.current;
    const currentIndex = paths.indexOf(path);
    const fallbackPath =
      currentIndex === -1
        ? undefined
        : currentIndex === paths.length - 1
          ? paths[currentIndex - 1]
          : paths[currentIndex + 1];

    if (fallbackPath) {
      actions.set_active_tab(path_to_tab(fallbackPath), {
        change_history: false,
      });
    } else if (current != null) {
      void actions.open_directory(current.root_path, false, true);
    } else {
      actions.set_active_tab("files", { change_history: false });
    }
    actions.close_tab(path);
  }

  const labelsForPaths = file_tab_labels(
    paths,
    paths.map((path) =>
      generatedWorkspaceChatLabel(
        path,
        workspaces.resolveWorkspaceForPath(path),
      ),
    ),
  );
  const labelMap = new Map<string, string>();
  for (let index = 0; index < labelsForPaths.length; index++) {
    labelMap.set(paths[index], `${labelsForPaths[index] ?? paths[index]}`);
  }

  const recentFiles = useRecentFiles(project_log, 8, "").filter(
    ({ filename }) => !paths.includes(filename),
  );
  const recentPaths = recentFiles.map(({ filename }) => filename);
  const recentLabels = file_tab_labels(
    recentPaths,
    recentPaths.map((path) =>
      generatedWorkspaceChatLabel(
        path,
        workspaces.resolveWorkspaceForPath(path),
      ),
    ),
  );
  const recentLabelMap = new Map<string, string>();
  for (let index = 0; index < recentPaths.length; index++) {
    recentLabelMap.set(
      recentPaths[index],
      `${recentLabels[index] ?? recentPaths[index]}`,
    );
  }

  const items: TabsProps["items"] = [];
  for (let index = 0; index < labelsForPaths.length; index++) {
    items.push({
      key: pathToKey(paths[index]),
      label: (
        <Label
          path={paths[index]}
          project_id={project_id}
          label={labelsForPaths[index]}
          onClose={closeVisibleTab}
        />
      ),
    });
  }

  const onEdit = (key: string, action: "add" | "remove") => {
    if (actions == null) return;
    if (action == "add") {
      actions.set_active_tab("files");
      return;
    }
    if (key) {
      closeVisibleTab(keyToPath(key));
    }
  };

  function onDragEnd(event) {
    if (actions == null) return;
    const { active, over } = event;
    if (active == null || over == null) {
      return;
    }
    setTimeout(() => {
      // This is a scary hack to fix https://github.com/sagemathinc/cocalc/issues/7029
      // which is I think working around some weirdness/optimization in CodeMirror 5.
      // I hate doing this, but it's better than the alternatives I can figure out right now.
      actions.show();
    }, 250);

    if (active.id == over.id) {
      return;
    }
    const globalOpenFiles = openFiles?.toJS?.() ?? openFiles ?? [];
    if (workspaces.selection.kind === "workspace") {
      const nextOrder = reorderVisibleSubset(
        globalOpenFiles,
        paths,
        keyToPath(active.id),
        keyToPath(over.id),
      );
      if (nextOrder != null) {
        actions.set_file_tab_order(nextOrder);
      }
      return;
    }
    actions.move_file_tab({
      old_index: keys.indexOf(active.id),
      new_index: keys.indexOf(over.id),
    });
  }

  const activeKey = activePath ? pathToKey(activePath) : "";

  function focusTabStripSoon(): void {
    setTimeout(() => {
      actions?.focus_file_tab_strip?.();
    }, 0);
  }

  function activateTabByKeyboard(
    index: number,
    currentTarget: HTMLDivElement,
  ): void {
    const tabs = Array.from(
      currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    tabs[index]?.click();
    focusTabStripSoon();
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.getAttribute("role") !== "tab") return;
    if (keys.length === 0) return;
    const currentIndex = Math.max(0, keys.indexOf(activeKey));
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + keys.length) % keys.length;
        break;
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % keys.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = keys.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    activateTabByKeyboard(nextIndex, event.currentTarget);
  }

  function onDragStart(event) {
    if (actions == null) return;
    if (event?.active?.id != activeKey) {
      const key = event?.active?.id;
      if (key) {
        actions.set_active_tab(path_to_tab(keyToPath(key)), {
          // noFocus -- critical to not focus when dragging or codemirror focus breaks on end of drag.
          // See  https://github.com/sagemathinc/cocalc/issues/7029
          noFocus: true,
        });
      }
    }
  }

  function renderFileRow(path: string, label: string) {
    const info = file_options(path);
    const { head } = path_split(path);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          minWidth: 0,
          width: "100%",
        }}
        title={path}
      >
        <Icon name={info.icon ?? "file"} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 500,
            }}
          >
            {label}
          </div>
          <div
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: COLORS.GRAY,
              fontSize: "12px",
            }}
          >
            {head || "/"}
          </div>
        </div>
      </div>
    );
  }

  function matchesSearch(path: string, label: string): boolean {
    const query = searchValue.trim().toLowerCase();
    if (!query) return true;
    return (
      path.toLowerCase().includes(query) || label.toLowerCase().includes(query)
    );
  }

  const filteredOpenPaths = paths.filter((path) =>
    matchesSearch(path, labelMap.get(path) ?? path),
  );
  const filteredRecentPaths = recentPaths.filter((path) =>
    matchesSearch(path, recentLabelMap.get(path) ?? path),
  );

  function openRecentFile(path: string): void {
    actions?.open_file?.({
      path,
      foreground: true,
      foreground_project: true,
    });
    setDropdownOpen(false);
    setSearchValue("");
  }

  function renderToggle(title: string) {
    return (
      <Tooltip title={title}>
        <Button
          size="small"
          style={mode === "tabs" ? { marginTop: "-16px" } : undefined}
          onClick={() => setTabsMode(mode === "tabs" ? "dropdown" : "tabs")}
        >
          {mode === "tabs" ? "Tabs" : "List"}
        </Button>
      </Tooltip>
    );
  }

  function renderDropdownMode() {
    const activeValue = paths.includes(activePath) ? activePath : undefined;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
        }}
      >
        {renderToggle("Switch to file tabs")}
        <Select
          size="middle"
          open={dropdownOpen}
          onDropdownVisibleChange={(open) => {
            setDropdownOpen(open);
            if (!open) setSearchValue("");
          }}
          style={{ minWidth: 260, maxWidth: 520, flex: "1 1 auto" }}
          placeholder="Switch file…"
          value={activeValue}
          showSearch
          filterOption={false}
          searchValue={searchValue}
          onSearch={setSearchValue}
          onClear={() => setSearchValue("")}
          allowClear
          options={filteredOpenPaths.map((path) => ({
            value: path,
            label: labelMap.get(path) ?? path,
          }))}
          onChange={(path) => {
            if (!path) return;
            actions?.set_active_tab(path_to_tab(path));
            setDropdownOpen(false);
            setSearchValue("");
          }}
          dropdownRender={() => (
            <>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <div
                  style={{ padding: "6px 8px", fontSize: 12, color: "#666" }}
                >
                  Open files
                </div>
                {filteredOpenPaths.length > 0 ? (
                  filteredOpenPaths.map((path) => (
                    <div
                      key={`open-${path}`}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        backgroundColor:
                          path === activePath ? COLORS.GRAY_L : undefined,
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        actions?.set_active_tab(path_to_tab(path));
                        setDropdownOpen(false);
                        setSearchValue("");
                      }}
                    >
                      {renderFileRow(path, labelMap.get(path) ?? path)}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: "8px 12px", color: "#888" }}>
                    No open files found
                  </div>
                )}
              </div>
              <Divider style={{ margin: "6px 0" }} />
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                <div
                  style={{ padding: "6px 8px", fontSize: 12, color: "#666" }}
                >
                  {intl.formatMessage(labels.recent_files)}
                </div>
                {filteredRecentPaths.length > 0 ? (
                  filteredRecentPaths.map((path) => (
                    <div
                      key={`recent-${path}`}
                      style={{ padding: "8px 12px", cursor: "pointer" }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => openRecentFile(path)}
                    >
                      {renderFileRow(path, recentLabelMap.get(path) ?? path)}
                    </div>
                  ))
                ) : project_log_loading ? (
                  <div style={{ padding: "8px 12px", color: "#888" }}>
                    Loading recent files...
                  </div>
                ) : (
                  <div style={{ padding: "8px 12px", color: "#888" }}>
                    No recent files yet
                  </div>
                )}
              </div>
            </>
          )}
        />
      </div>
    );
  }

  function renderTabsMode() {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
        }}
      >
        {renderToggle("Switch to file list")}
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <SortableTabs
            items={keys}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <div
              {...{ [FILE_TAB_STRIP_ATTRIBUTE]: project_id }}
              onKeyDownCapture={onTabKeyDown}
            >
              <Tabs
                animated={false}
                renderTabBar={renderTabBar}
                tabBarStyle={{
                  minHeight: "36px",
                  background: "#e8e8e8",
                  borderTop: "2px solid lightgrey",
                }}
                onEdit={onEdit}
                style={{ width: "100%" }}
                size="small"
                items={items}
                activeKey={activeKey}
                type={"editable-card"}
                onChange={(key) => {
                  if (actions == null || !key) return;
                  actions.set_active_tab(path_to_tab(keyToPath(key)));
                }}
                classNames={{ popup: { root: "cocalc-files-tabs-more" } }}
              />
            </div>
          </SortableTabs>
        </div>
      </div>
    );
  }

  if (openFiles == null) {
    return null;
  }

  return mode === "dropdown" ? renderDropdownMode() : renderTabsMode();
}
