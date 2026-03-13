/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { dirname } from "path";

import { Alert, Button, Checkbox, Menu, Spin } from "antd";
import type { MenuProps } from "antd";
import * as immutable from "immutable";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TableVirtuoso, type TableVirtuosoHandle } from "react-virtuoso";
import { useIntl } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { labels } from "@cocalc/frontend/i18n";
import { should_open_in_foreground } from "@cocalc/frontend/lib/should-open-in-foreground";
import { open_new_tab } from "@cocalc/frontend/misc";
import { buildFileActionItems } from "@cocalc/frontend/project/file-context-menu";
import { useStarredFilesManager } from "@cocalc/frontend/project/page/flyouts/store";
import { FILE_ITEM_OPENED_STYLE } from "@cocalc/frontend/project/page/flyouts/file-list-item";
import { fileItemStyle } from "@cocalc/frontend/project/page/flyouts/utils";
import { type DirectoryListingEntry } from "@cocalc/frontend/project/explorer/types";
import {
  type FileAction,
  type ProjectActions,
} from "@cocalc/frontend/project_actions";
import { url_href } from "@cocalc/frontend/project/utils";
import { COLORS } from "@cocalc/util/theme";
import { isBackupsPath, BACKUPS } from "@cocalc/util/consts/backups";
import { isSnapshotsPath, SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import * as misc from "@cocalc/util/misc";

import {
  useFileDrag,
  useFolderDrop,
} from "@cocalc/frontend/project/explorer/dnd/file-dnd-provider";
import { useSpecialPathPreview } from "@cocalc/frontend/project/explorer/use-special-path-preview";

import NoFiles from "./no-files";
import { TERM_MODE_CHAR, VIEWABLE_FILE_EXT } from "./utils";

const COL_W = {
  CHECKBOX: 40,
  TYPE: 54,
  PUBLIC: 40,
  STAR: 44,
  DATE: 170,
  SIZE: 120,
  ACTIONS: 44,
} as const;

const NARROW_WIDTH_PX = 780;

const TABLE_COMPONENTS = {
  Table: function ExplorerTable(
    props: React.HTMLAttributes<HTMLTableElement> & {
      style?: React.CSSProperties;
    },
  ) {
    return (
      <table
        {...props}
        style={{ ...props.style, tableLayout: "fixed", width: "100%" }}
        className="ant-table-content"
      />
    );
  },
  TableHead: React.forwardRef<
    HTMLTableSectionElement,
    React.HTMLAttributes<HTMLTableSectionElement>
  >(function ExplorerTableHead(props, ref) {
    return <thead {...props} ref={ref} className="ant-table-thead" />;
  }),
  TableRow: VirtualTableRow,
};

interface Props {
  actions: ProjectActions;
  active_file_sort: { column_name: string; is_descending: boolean };
  listing: DirectoryListingEntry[];
  file_search: string;
  checked_files: immutable.Set<string>;
  current_path: string;
  project_id: string;
  shiftIsDown: boolean;
  isRunning?: boolean;
  publicFiles: Set<string>;
  sort_by: (column_name: string) => void;
  onNavigateDirectory?: (path: string) => void;
}

interface FileEntry extends DirectoryListingEntry {
  display_name?: string;
  fullPath: string;
  isOpen: boolean;
  isPublic: boolean;
  isStarred: boolean;
}

interface DndRowContextType {
  currentPath: string;
  projectId: string;
  disableActions: boolean;
  getRecord: (index: number) => FileEntry | undefined;
  getDragPaths: (record: FileEntry) => string[];
  onRow: (record: FileEntry) => {
    onClick: (e: React.MouseEvent) => void;
    onMouseDown: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    style: React.CSSProperties;
  };
}

const DndRowContext = React.createContext<DndRowContextType | null>(null);

function SortIndicator({
  columnKey,
  sortColumn,
  sortDescending,
}: {
  columnKey: string;
  sortColumn?: string;
  sortDescending?: boolean;
}) {
  if (sortColumn !== columnKey) return null;
  return (
    <Icon
      name={sortDescending ? "caret-down" : "caret-up"}
      style={{ color: COLORS.ANTD_LINK_BLUE, marginLeft: 4 }}
    />
  );
}

function useContainerWidth(el: HTMLDivElement | null): number {
  const [width, setWidth] = useState(1200);

  useEffect(() => {
    if (el == null) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return width;
}

function renderTimestamp(mtime?: number): React.ReactNode {
  if (mtime == null) return null;
  try {
    return (
      <TimeAgo
        date={new Date(mtime).toISOString()}
        style={{ color: COLORS.GRAY_M, whiteSpace: "nowrap" }}
      />
    );
  } catch {
    return (
      <span style={{ color: COLORS.GRAY_M, whiteSpace: "nowrap" }}>
        Invalid Date
      </span>
    );
  }
}

function renderFileIcon(record: FileEntry) {
  const color = record.mask ? COLORS.GRAY_M : COLORS.FILE_ICON;
  if (record.isDir) {
    return (
      <Icon
        name="folder-open"
        style={{ fontSize: "14pt", color, verticalAlign: "sub" }}
      />
    );
  }

  const info = file_options(record.name);
  const iconName = info?.icon ?? "file";
  return (
    <Icon
      name={iconName}
      style={{ fontSize: "14pt", color, verticalAlign: "sub" }}
    />
  );
}

function renderFileName(record: FileEntry) {
  let displayName = record.display_name ?? record.name;
  let ext = "";
  if (!record.isDir) {
    const parts = misc.separate_file_extension(displayName);
    displayName = parts.name;
    ext = parts.ext;
  }

  return (
    <span
      title={record.name}
      style={{
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: record.mask ? COLORS.GRAY_M : COLORS.TAB,
        ...(record.isOpen ? FILE_ITEM_OPENED_STYLE : undefined),
      }}
    >
      {displayName}
      {ext !== "" && (
        <span
          style={{ color: record.mask ? COLORS.GRAY_M : COLORS.FILE_DIMMED }}
        >
          .{ext}
        </span>
      )}
      {record.linkTarget != null && record.linkTarget !== record.name && (
        <>
          {" "}
          <Icon name="arrow-right" style={{ margin: "0 10px" }} />{" "}
          {record.linkTarget}
        </>
      )}
    </span>
  );
}

function VirtualTableRow(props: React.HTMLAttributes<HTMLTableRowElement>) {
  const ctx = React.useContext(DndRowContext);
  const index = (props as any)["data-item-index"] as number | undefined;
  if (!ctx || index == null) {
    return <tr {...props} />;
  }

  const record = ctx.getRecord(index);
  if (record == null) {
    return <tr {...props} />;
  }

  if (ctx.disableActions) {
    const rowProps = ctx.onRow(record);
    return (
      <tr
        {...props}
        onClick={rowProps.onClick}
        onMouseDown={rowProps.onMouseDown}
        onContextMenu={rowProps.onContextMenu}
        style={{ ...props.style, ...rowProps.style }}
        className={`ant-table-row ${props.className ?? ""}`}
      />
    );
  }

  if (record.name === "..") {
    return <VirtualDropOnlyRow {...props} ctx={ctx} record={record} />;
  }

  return <VirtualDraggableRow {...props} ctx={ctx} record={record} />;
}

function VirtualDropOnlyRow({
  ctx,
  record,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & {
  ctx: DndRowContextType;
  record: FileEntry;
}) {
  const parentPath = dirname(ctx.currentPath) || "/";
  const { dropRef, isOver, isInvalidDrop } = useFolderDrop(
    `explorer-folder-${parentPath}`,
    parentPath,
  );
  const rowProps = ctx.onRow(record);
  return (
    <tr
      {...props}
      ref={dropRef}
      onClick={rowProps.onClick}
      onMouseDown={rowProps.onMouseDown}
      onContextMenu={rowProps.onContextMenu}
      style={{
        ...props.style,
        ...rowProps.style,
        ...(isOver ? { background: COLORS.BLUE_LLL } : {}),
        ...(isInvalidDrop ? { background: COLORS.ANTD_RED_WARN } : {}),
      }}
      data-folder-drop-path={parentPath}
      className={`ant-table-row ${props.className ?? ""}`}
    />
  );
}

function VirtualDraggableRow({
  ctx,
  record,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & {
  ctx: DndRowContextType;
  record: FileEntry;
}) {
  const { dragRef, dragListeners, dragAttributes, isDragging } = useFileDrag(
    `explorer-row-${record.fullPath}`,
    ctx.getDragPaths(record),
    ctx.projectId,
  );
  const { dropRef, isOver, isInvalidDrop } = useFolderDrop(
    record.isDir
      ? `explorer-folder-${record.fullPath}`
      : `noop-${record.fullPath}`,
    record.fullPath,
    record.isDir,
  );

  const mergedRef = useCallback(
    (node: HTMLTableRowElement | null) => {
      dragRef(node);
      if (record.isDir) {
        dropRef(node);
      }
    },
    [dragRef, dropRef, record.isDir],
  );

  const rowProps = ctx.onRow(record);
  const onDragMouseDown = (dragListeners as any)?.onMouseDown as
    | ((event: React.MouseEvent<HTMLTableRowElement>) => void)
    | undefined;

  return (
    <tr
      {...props}
      {...dragListeners}
      {...dragAttributes}
      ref={mergedRef}
      onClick={rowProps.onClick}
      onMouseDown={(e) => {
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          onDragMouseDown?.(e);
        }
        rowProps.onMouseDown();
      }}
      onContextMenu={rowProps.onContextMenu}
      style={{
        ...props.style,
        ...rowProps.style,
        ...(isOver ? { background: COLORS.BLUE_LLL } : {}),
        ...(isInvalidDrop ? { background: COLORS.ANTD_RED_WARN } : {}),
        opacity: isDragging ? 0.45 : rowProps.style.opacity,
      }}
      {...(record.isDir ? { "data-folder-drop-path": record.fullPath } : {})}
      className={`ant-table-row ${props.className ?? ""}`}
    />
  );
}

export function FileListing({
  actions,
  active_file_sort,
  listing,
  checked_files,
  current_path,
  project_id,
  shiftIsDown,
  file_search = "",
  publicFiles,
  sort_by,
  onNavigateDirectory,
}: Props) {
  const intl = useIntl();
  const selected_file_index =
    useTypedRedux({ project_id }, "selected_file_index") ?? 0;
  const openFilesOrder = useTypedRedux({ project_id }, "open_files_order");
  const hide_masked_files =
    useTypedRedux({ project_id }, "hide_masked_files") ?? false;
  const student_project_functionality =
    useStudentProjectFunctionality(project_id);
  const { starred, setStarredPath } = useStarredFilesManager(project_id);
  const starredSet = useMemo(() => new Set(starred), [starred]);
  const { onOpenSpecial, modal } = useSpecialPathPreview({
    project_id,
    actions,
    current_path,
  });

  const openFiles = useMemo(
    () => new Set<string>(openFilesOrder?.toJS() ?? []),
    [openFilesOrder],
  );

  const [contextMenu, setContextMenu] = useState<{
    items: MenuProps["items"];
    x: number;
    y: number;
  } | null>(null);
  const selectionRef = useRef("");
  const virtuosoRef = useRef<TableVirtuosoHandle>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const containerWidth = useContainerWidth(containerEl);
  const isNarrow = containerWidth < NARROW_WIDTH_PX;
  const sortColumn = active_file_sort?.column_name;
  const sortDescending = active_file_sort?.is_descending;

  const dataSource = useMemo<FileEntry[]>(() => {
    return listing
      .filter((entry) => (hide_masked_files ? !entry.mask : true))
      .map((entry) => {
        const fullPath = misc.path_to_file(current_path, entry.name);
        return {
          ...entry,
          fullPath,
          isOpen: openFiles.has(fullPath),
          isPublic: publicFiles.has(entry.name),
          isStarred: starredSet.has(entry.isDir ? `${fullPath}/` : fullPath),
        };
      });
  }, [
    listing,
    hide_masked_files,
    current_path,
    openFiles,
    publicFiles,
    starredSet,
  ]);

  const selectedRowKeys = useMemo(() => {
    const keys: string[] = [];
    for (const record of dataSource) {
      if (checked_files.has(record.fullPath)) {
        keys.push(record.fullPath);
      }
    }
    return keys;
  }, [checked_files, dataSource]);

  useEffect(() => {
    if (selected_file_index == null || selected_file_index < 0) {
      return;
    }
    if (selected_file_index >= dataSource.length) {
      return;
    }
    virtuosoRef.current?.scrollToIndex({
      index: selected_file_index,
      align: "center",
    });
  }, [selected_file_index, dataSource]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [contextMenu]);

  const handleToggleStar = useCallback(
    (record: FileEntry, starred: boolean) => {
      setStarredPath(
        record.isDir ? `${record.fullPath}/` : record.fullPath,
        starred,
      );
    },
    [setStarredPath],
  );

  const triggerFileAction = useCallback(
    (fullPath: string, action: FileAction) => {
      actions.set_file_checked(fullPath, true);
      actions.set_file_action(action);
    },
    [actions],
  );

  const buildContextMenu = useCallback(
    (record: FileEntry): MenuProps["items"] => {
      if (
        record.name === ".." ||
        student_project_functionality.disableActions
      ) {
        return [];
      }

      const multiple =
        checked_files.size > 1 || checked_files.has(record.fullPath);
      const items: NonNullable<MenuProps["items"]> = [
        {
          key: "open",
          icon: <Icon name={record.isDir ? "folder-open" : "edit-filled"} />,
          label: record.isDir ? "Open folder" : "Open file",
          onClick: () => {
            if (record.isDir) {
              if (onNavigateDirectory) {
                onNavigateDirectory(record.fullPath);
              } else {
                actions.open_directory(record.fullPath);
              }
              actions.set_file_search("");
            } else {
              actions.open_file({
                path: record.fullPath,
                foreground: true,
                explicit: true,
              });
              actions.set_file_search("");
            }
          },
        },
      ];

      if (!record.isDir) {
        const ext = misc.filename_extension(record.name)?.toLowerCase() ?? "";
        if (VIEWABLE_FILE_EXT.includes(ext)) {
          items.push({
            key: "view",
            icon: <Icon name="eye" />,
            label: "View file",
            onClick: () =>
              open_new_tab(url_href(actions.project_id, record.fullPath)),
          });
        }
      }

      items.push({ key: "divider-1", type: "divider" });
      items.push(
        ...buildFileActionItems({
          isdir: !!record.isDir,
          intl,
          multiple,
          disableActions: student_project_functionality.disableActions,
          inSnapshots: isSnapshotsPath(current_path),
          fullPath: record.fullPath,
          triggerFileAction: (action) =>
            triggerFileAction(record.fullPath, action),
        }),
      );

      if (!record.isDir) {
        items.push({ key: "divider-2", type: "divider" });
        items.push({
          key: "download",
          icon: <Icon name="cloud-download" />,
          label: intl.formatMessage(labels.download),
          onClick: () =>
            actions.download_file({ path: record.fullPath, log: true }),
        });
      }

      return items;
    },
    [
      student_project_functionality.disableActions,
      checked_files,
      current_path,
      intl,
      triggerFileAction,
      onNavigateDirectory,
      actions,
    ],
  );

  const handleRowClick = useCallback(
    (record: FileEntry, e: React.MouseEvent) => {
      if ((window.getSelection()?.toString() ?? "") !== selectionRef.current) {
        return;
      }

      if (e.shiftKey) {
        actions.set_selected_file_range(
          record.fullPath,
          true,
          dataSource,
          current_path,
        );
        actions.set_most_recent_file_click(record.fullPath);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && checked_files.size > 0) {
        actions.set_file_checked(
          record.fullPath,
          !checked_files.has(record.fullPath),
        );
        actions.set_most_recent_file_click(record.fullPath);
        return;
      }

      actions.set_most_recent_file_click(record.fullPath);
      if (onOpenSpecial?.(record.fullPath, !!record.isDir)) {
        return;
      }

      if (record.isDir) {
        if (onNavigateDirectory) {
          onNavigateDirectory(record.fullPath);
        } else {
          actions.open_directory(record.fullPath);
        }
        actions.set_file_search("");
        return;
      }

      const foreground = should_open_in_foreground(e as any);
      actions.open_file({
        path: record.fullPath,
        foreground,
        explicit: true,
      });
      if (foreground) {
        actions.set_file_search("");
      }
    },
    [
      actions,
      checked_files,
      current_path,
      dataSource,
      onNavigateDirectory,
      onOpenSpecial,
    ],
  );

  const handleCheckboxChange = useCallback(
    (record: FileEntry, checked: boolean, event?: { shiftKey?: boolean }) => {
      if (event?.shiftKey) {
        actions.set_selected_file_range(
          record.fullPath,
          checked,
          dataSource,
          current_path,
        );
      } else {
        actions.set_file_checked(record.fullPath, checked);
      }
      actions.set_most_recent_file_click(record.fullPath);
    },
    [actions, current_path, dataSource],
  );

  const handleSelectAll = useCallback(
    (e: { target: { checked: boolean } }) => {
      actions.set_all_files_unchecked();
      if (e.target.checked) {
        actions.set_file_list_checked(
          dataSource
            .filter((record) => record.name !== "..")
            .map((record) => record.fullPath),
        );
      }
    },
    [actions, dataSource],
  );

  const selectableCount = dataSource.filter(
    (record) => record.name !== "..",
  ).length;
  const allChecked =
    selectableCount > 0 && selectedRowKeys.length === selectableCount;
  const someChecked = selectedRowKeys.length > 0 && !allChecked;

  const onRow = useCallback(
    (record: FileEntry) => {
      const isSelected =
        selected_file_index >= 0 &&
        selected_file_index < dataSource.length &&
        dataSource[selected_file_index]?.fullPath === record.fullPath &&
        file_search[0] !== TERM_MODE_CHAR;
      const isChecked = checked_files.has(record.fullPath);

      return {
        onClick: (e: React.MouseEvent) => handleRowClick(record, e),
        onMouseDown: () => {
          selectionRef.current = window.getSelection()?.toString() ?? "";
        },
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          const items = buildContextMenu(record);
          if ((items?.length ?? 0) > 0) {
            setContextMenu({ items, x: e.clientX, y: e.clientY });
          }
        },
        style: {
          cursor: "pointer",
          ...(fileItemStyle(
            record.mtime ?? 0,
            !!record.mask,
          ) as React.CSSProperties),
          ...(record.isOpen ? FILE_ITEM_OPENED_STYLE : undefined),
          ...(isChecked ? { backgroundColor: COLORS.GRAY_LLL } : undefined),
          ...(isSelected ? { backgroundColor: COLORS.BLUE_LLL } : undefined),
          ...(record.mask ? { color: COLORS.FILE_DIMMED } : undefined),
        } satisfies React.CSSProperties,
      };
    },
    [
      selected_file_index,
      dataSource,
      file_search,
      checked_files,
      handleRowClick,
      buildContextMenu,
    ],
  );

  const dndRowCtx = useMemo<DndRowContextType>(
    () => ({
      currentPath: current_path,
      projectId: project_id,
      disableActions: !!student_project_functionality.disableActions,
      getRecord: (index: number) => dataSource[index],
      getDragPaths: (record: FileEntry) => {
        if (checked_files.has(record.fullPath)) {
          return checked_files.toArray();
        }
        if (checked_files.size > 0) {
          return [...checked_files.toArray(), record.fullPath];
        }
        return [record.fullPath];
      },
      onRow,
    }),
    [
      current_path,
      project_id,
      student_project_functionality.disableActions,
      dataSource,
      checked_files,
      onRow,
    ],
  );

  const fixedHeaderContent = useCallback(() => {
    const thStyle: React.CSSProperties = {
      padding: "8px",
      textAlign: "left",
      position: "sticky",
      top: 0,
      background: COLORS.GRAY_LL,
      borderBottom: `1px solid ${COLORS.GRAY_L0}`,
      fontWeight: 600,
      zIndex: 1,
    };

    return (
      <tr>
        {!student_project_functionality.disableActions && (
          <th style={{ ...thStyle, width: COL_W.CHECKBOX }}>
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              onChange={handleSelectAll}
            />
          </th>
        )}
        <th style={{ ...thStyle, width: COL_W.PUBLIC }} />
        <th style={{ ...thStyle, width: COL_W.TYPE }} />
        <th style={{ ...thStyle, width: COL_W.STAR }}>
          <Icon name="star" />
        </th>
        <th style={thStyle} onClick={() => sort_by("name")}>
          {intl.formatMessage(labels.name)}
          <SortIndicator
            columnKey="name"
            sortColumn={sortColumn}
            sortDescending={sortDescending}
          />
        </th>
        <th
          style={{ ...thStyle, width: COL_W.DATE }}
          onClick={() => sort_by("time")}
        >
          Date Modified
          <SortIndicator
            columnKey="time"
            sortColumn={sortColumn}
            sortDescending={sortDescending}
          />
        </th>
        {!isNarrow && (
          <>
            <th
              style={{ ...thStyle, width: COL_W.SIZE, textAlign: "right" }}
              onClick={() => sort_by("size")}
            >
              Size
              <SortIndicator
                columnKey="size"
                sortColumn={sortColumn}
                sortDescending={sortDescending}
              />
            </th>
            <th style={{ ...thStyle, width: COL_W.ACTIONS }} />
          </>
        )}
      </tr>
    );
  }, [
    student_project_functionality.disableActions,
    allChecked,
    someChecked,
    handleSelectAll,
    sort_by,
    intl,
    sortColumn,
    sortDescending,
    isNarrow,
  ]);

  const itemContent = useCallback(
    (_index: number, record: FileEntry) => {
      const cellStyle: React.CSSProperties = {
        padding: "6px 8px",
        background: "transparent",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        borderBottom: `1px solid ${COLORS.GRAY_LLL}`,
      };

      return (
        <>
          {!student_project_functionality.disableActions && (
            <td style={{ ...cellStyle, width: COL_W.CHECKBOX }}>
              <Checkbox
                checked={checked_files.has(record.fullPath)}
                disabled={record.name === ".."}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  handleCheckboxChange(record, e.target.checked, e.nativeEvent)
                }
              />
            </td>
          )}
          <td
            style={{ ...cellStyle, width: COL_W.PUBLIC, textAlign: "center" }}
          >
            {record.isPublic ? (
              <Icon name="share-square" style={{ color: COLORS.TAB }} />
            ) : null}
          </td>
          <td style={{ ...cellStyle, width: COL_W.TYPE, textAlign: "center" }}>
            {renderFileIcon(record)}
          </td>
          <td style={{ ...cellStyle, width: COL_W.STAR, textAlign: "center" }}>
            <Icon
              name={record.isStarred ? "star-filled" : "star"}
              onClick={(e) => {
                if (!e) return;
                e.preventDefault();
                e.stopPropagation();
                handleToggleStar(record, !record.isStarred);
              }}
              style={{
                cursor: "pointer",
                fontSize: "14pt",
                color: record.isStarred ? COLORS.STAR : COLORS.GRAY_L,
              }}
            />
          </td>
          <td style={cellStyle}>{renderFileName(record)}</td>
          <td style={{ ...cellStyle, width: COL_W.DATE }}>
            {renderTimestamp(record.mtime)}
          </td>
          {!isNarrow && (
            <>
              <td
                style={{ ...cellStyle, width: COL_W.SIZE, textAlign: "right" }}
              >
                {record.isDir ? (
                  <span style={{ color: COLORS.GRAY_M }}>
                    {record.size != null
                      ? `${record.size} ${misc.plural(record.size, "item")}`
                      : ""}
                  </span>
                ) : (
                  <Button
                    type="text"
                    size="small"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      actions.download_file({
                        path: record.fullPath,
                        log: true,
                      });
                    }}
                    style={{
                      color: COLORS.GRAY_M,
                      whiteSpace: "nowrap",
                      padding: 0,
                      height: "auto",
                    }}
                  >
                    {misc.human_readable_size(record.size)}
                    <Icon
                      name="cloud-download"
                      style={{ color: COLORS.GRAY_M, marginLeft: 6 }}
                    />
                  </Button>
                )}
              </td>
              <td
                style={{
                  ...cellStyle,
                  width: COL_W.ACTIONS,
                  textAlign: "center",
                }}
              >
                {record.name !== ".." &&
                  !student_project_functionality.disableActions && (
                    <Button
                      type="text"
                      size="small"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const items = buildContextMenu(record);
                        if ((items?.length ?? 0) > 0) {
                          setContextMenu({ items, x: e.clientX, y: e.clientY });
                        }
                      }}
                      style={{ color: COLORS.TAB }}
                    >
                      <Icon name="ellipsis" rotate="90" />
                    </Button>
                  )}
              </td>
            </>
          )}
        </>
      );
    },
    [
      student_project_functionality.disableActions,
      checked_files,
      handleCheckboxChange,
      handleToggleStar,
      isNarrow,
      actions,
      buildContextMenu,
    ],
  );

  if (dataSource == null) {
    return <Spin delay={500} />;
  }

  const isSnapshotsVirtualPath = isSnapshotsPath(current_path);
  const isBackupsVirtualPath = isBackupsPath(current_path);
  const isReadonlyVirtualPath = isSnapshotsVirtualPath || isBackupsVirtualPath;

  if (dataSource.length === 0 && file_search[0] !== TERM_MODE_CHAR) {
    return (
      <>
        {isSnapshotsVirtualPath ? (
          <Alert
            style={{ marginBottom: 8 }}
            type="info"
            showIcon
            title="Snapshots vs Backups"
            description={
              <>
                Snapshots in this folder are fast local readonly filesystem
                checkpoints on the current project host, which you can directly
                open or copy. Backups are durable, deduplicated archives stored
                separately, which can only be restored. Use Backups to restore
                files that might be missing from snapshots or if a project host
                is not available.
              </>
            }
            action={
              <Button
                size="small"
                onClick={() => actions.open_directory(BACKUPS)}
              >
                Open Backups
              </Button>
            }
          />
        ) : isBackupsVirtualPath ? (
          <Alert
            style={{ marginBottom: 8 }}
            type="info"
            showIcon
            title="Backups vs Snapshots"
            description={
              <>
                Backups are durable, deduplicated archives stored separately,
                which can only be restored. Snapshots are fast local readonly
                filesystem checkpoints on the current project host that you can
                open or copy directly. Use Snapshots for quick local recovery.
              </>
            }
            action={
              <Button
                size="small"
                onClick={() => actions.open_directory(SNAPSHOTS)}
              >
                Open Snapshots
              </Button>
            }
          />
        ) : null}
        {isReadonlyVirtualPath ? (
          <Alert
            type="info"
            showIcon
            style={{ margin: "8px 16px 0 16px" }}
            message={
              file_search.trim()
                ? "No files or folders match the current filter."
                : "No files or folders to display."
            }
          />
        ) : (
          <NoFiles
            current_path={current_path}
            file_search={file_search}
            project_id={project_id}
          />
        )}
        {modal}
      </>
    );
  }

  return (
    <>
      {isSnapshotsVirtualPath ? (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          showIcon
          title="Snapshots vs Backups"
          description={
            <>
              Snapshots in this folder are fast local readonly filesystem
              checkpoints on the current project host, which you can directly
              open or copy. Backups are durable, deduplicated archives stored
              separately, which can only be restored. Use Backups to restore
              files that might be missing from snapshots or if a project host is
              not available.
            </>
          }
          action={
            <Button
              size="small"
              onClick={() => actions.open_directory(BACKUPS)}
            >
              Open Backups
            </Button>
          }
        />
      ) : isBackupsVirtualPath ? (
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          showIcon
          title="Backups vs Snapshots"
          description={
            <>
              Backups are durable, deduplicated archives stored separately,
              which can only be restored. Snapshots are fast local readonly
              filesystem checkpoints on the current project host that you can
              open or copy directly. Use Snapshots for quick local recovery.
            </>
          }
          action={
            <Button
              size="small"
              onClick={() => actions.open_directory(SNAPSHOTS)}
            >
              Open Snapshots
            </Button>
          }
        />
      ) : null}
      <DndRowContext.Provider value={dndRowCtx}>
        <div
          ref={setContainerEl}
          className={`smc-vfill${shiftIsDown ? " noselect" : ""}`}
          style={{ minHeight: 0, position: "relative" }}
        >
          <TableVirtuoso
            ref={virtuosoRef}
            style={{ flex: 1, minHeight: 0 }}
            data={dataSource}
            computeItemKey={(_index, record) => record.fullPath}
            overscan={200}
            components={TABLE_COMPONENTS}
            fixedHeaderContent={fixedHeaderContent}
            itemContent={itemContent}
          />
        </div>
      </DndRowContext.Provider>
      {contextMenu && (
        <div
          ref={(el) => {
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (rect.right > vw) {
              el.style.left = `${Math.max(0, vw - rect.width)}px`;
            }
            if (rect.bottom > vh) {
              el.style.top = `${Math.max(0, vh - rect.height)}px`;
            }
          }}
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1050,
          }}
        >
          <Menu
            items={contextMenu.items}
            onClick={() => setContextMenu(null)}
            style={{
              minWidth: 180,
              borderRadius: 8,
              boxShadow: "0 6px 16px 0 rgba(0,0,0,0.12)",
            }}
          />
        </div>
      )}
      {modal}
    </>
  );
}
