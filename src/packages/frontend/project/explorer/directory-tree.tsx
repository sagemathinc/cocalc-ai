/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tree } from "antd";
import type { TreeDataNode, TreeProps } from "antd";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { useProjectContext } from "@cocalc/frontend/project/context";
import useFs from "@cocalc/frontend/project/listing/use-fs";
import { COLORS } from "@cocalc/util/theme";
import { isBackupsPath } from "@cocalc/util/consts/backups";
import * as misc from "@cocalc/util/misc";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import { Icon } from "@cocalc/frontend/components";

import { useFileDrag, useFolderDrop } from "./dnd/file-dnd-provider";

export const DIRECTORY_TREE_DEFAULT_WIDTH_PX = 280;
export const DIRECTORY_TREE_MIN_WIDTH_PX = 180;
export const DIRECTORY_TREE_MAX_WIDTH_PX = 520;
const MAX_TREE_EXPANDED = 20;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value) && value > 0;
}

function directoryTreeWidthKey(project_id: string): string {
  return `${project_id}::explorer-directory-tree-width`;
}

function directoryTreeExpandedKeysKey(project_id: string): string {
  return `${project_id}::explorer-directory-tree-expanded-keys`;
}

export function getDirectoryTreeWidth(project_id: string): number {
  const width = LS.get<number>(directoryTreeWidthKey(project_id));
  if (!isPositiveNumber(width)) return DIRECTORY_TREE_DEFAULT_WIDTH_PX;
  return Math.max(
    DIRECTORY_TREE_MIN_WIDTH_PX,
    Math.min(width, DIRECTORY_TREE_MAX_WIDTH_PX),
  );
}

export function setDirectoryTreeWidth(project_id: string, width: number): void {
  LS.set(directoryTreeWidthKey(project_id), width);
}

function getDirectoryTreeExpandedKeys(project_id: string): string[] {
  const keys = LS.get<string[]>(directoryTreeExpandedKeysKey(project_id));
  return Array.isArray(keys) ? keys : [];
}

function saveDirectoryTreeExpandedKeys(
  project_id: string,
  keys: string[],
): void {
  LS.set(
    directoryTreeExpandedKeysKey(project_id),
    keys.slice(0, MAX_TREE_EXPANDED),
  );
}

function getRootPath(
  current_path: string,
  homeDirectory?: string,
): string | null {
  if (
    current_path.startsWith(".") ||
    isSnapshotsPath(current_path) ||
    isBackupsPath(current_path)
  ) {
    return null;
  }
  if (
    homeDirectory &&
    current_path !== "/" &&
    (current_path === homeDirectory ||
      current_path.startsWith(`${homeDirectory}/`))
  ) {
    return homeDirectory;
  }
  if (current_path === "/tmp" || current_path.startsWith("/tmp/")) {
    return "/tmp";
  }
  if (current_path === "/scratch" || current_path.startsWith("/scratch/")) {
    return "/scratch";
  }
  return "/";
}

function getAncestorPaths(rootPath: string, currentPath: string): string[] {
  if (
    currentPath !== rootPath &&
    !(rootPath === "/"
      ? currentPath.startsWith("/")
      : currentPath.startsWith(`${rootPath}/`))
  ) {
    return [rootPath];
  }
  if (currentPath === rootPath) return [rootPath];
  const relative =
    rootPath === "/"
      ? currentPath.replace(/^\/+/, "")
      : currentPath.slice(rootPath.length + 1);
  const parts = relative.split("/").filter(Boolean);
  const ancestors = [rootPath];
  let current = rootPath;
  for (const part of parts) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    ancestors.push(current);
  }
  return ancestors;
}

function rootLabel(rootPath: string, homeDirectory?: string): string {
  if (homeDirectory && rootPath === homeDirectory) {
    return "Home";
  }
  return rootPath || "/";
}

const PANEL_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
  paddingRight: 4,
} as const;

type DirectoryTreeDirent = {
  name?: string;
  isDirectory?: () => boolean;
};

type DirectoryTreeNamedDirent = {
  name: string;
  isDirectory: () => boolean;
};

const DirectoryTreeNodeTitle = React.memo(function DirectoryTreeNodeTitle({
  project_id,
  path,
  label,
  isRoot,
  isStarred,
  onToggleStar,
}: {
  project_id: string;
  path: string;
  label: string;
  isRoot: boolean;
  isStarred: boolean;
  onToggleStar: (path: string, starred: boolean) => void;
}) {
  const explorerBrowsingPathAbs = useTypedRedux(
    { project_id },
    "explorer_browsing_path_abs",
  );
  const currentPathAbs = useTypedRedux({ project_id }, "current_path_abs");
  const effectiveCurrentPath = explorerBrowsingPathAbs ?? currentPathAbs ?? "/";
  const isSelected = effectiveCurrentPath === path;
  const enableDnD = !isRoot;
  const { dragRef, dragListeners, dragAttributes, isDragging } = useFileDrag(
    `explorer-dir-tree-${project_id}-${path}`,
    enableDnD ? [path] : [],
    project_id,
  );
  const { dropRef, isOver, isInvalidDrop } = useFolderDrop(
    `explorer-dir-tree-drop-${project_id}-${path}`,
    path,
  );
  const combinedRef = useCallback(
    (node: HTMLSpanElement | null) => {
      dragRef(node);
      dropRef(node);
    },
    [dragRef, dropRef],
  );

  return (
    <span
      ref={combinedRef}
      data-folder-drop-path={path}
      {...(enableDnD ? { ...dragListeners, ...dragAttributes } : {})}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        minWidth: 0,
        padding: "2px 4px",
        borderRadius: 4,
        background: isOver
          ? COLORS.BLUE_LLL
          : isInvalidDrop
            ? COLORS.ANTD_RED_WARN
            : isSelected
              ? COLORS.BLUE_LLLL
              : "transparent",
        opacity: isDragging ? 0.45 : 1,
      }}
    >
      {isRoot ? (
        <Icon name={label === "Home" ? "home" : "folder-open"} />
      ) : (
        <Icon
          name={isStarred ? "star-filled" : "star"}
          style={{
            color: isStarred ? COLORS.STAR : COLORS.GRAY_L,
            cursor: "pointer",
          }}
          onClick={(e) => {
            if (!e) return;
            e.preventDefault();
            e.stopPropagation();
            onToggleStar(`${path}/`, !isStarred);
          }}
        />
      )}
      <span
        title={path}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: isSelected ? COLORS.ANTD_LINK_BLUE : undefined,
        }}
      >
        {label}
      </span>
    </span>
  );
});

DirectoryTreeNodeTitle.displayName = "DirectoryTreeNodeTitle";

export function DirectoryTreeDragbar({
  onWidthChange,
  currentWidth,
  onReset,
}: {
  onWidthChange: (width: number) => void;
  currentWidth: number;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = currentWidth;
      setDragging(true);

      function onMove(ev: PointerEvent) {
        const nextWidth = startWidth + (ev.clientX - startX);
        onWidthChange(
          Math.max(
            DIRECTORY_TREE_MIN_WIDTH_PX,
            Math.min(nextWidth, DIRECTORY_TREE_MAX_WIDTH_PX),
          ),
        );
      }

      function onUp() {
        setDragging(false);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [currentWidth, onWidthChange],
  );

  return (
    <div
      className="cc-project-flyout-dragbar"
      style={{
        flex: "0 0 5px",
        width: 5,
        height: "100%",
        cursor: "col-resize",
        ...(dragging ? { zIndex: 1000, backgroundColor: COLORS.GRAY } : {}),
      }}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
    />
  );
}

export function DirectoryTreePanel({
  project_id,
  current_path,
  show_hidden,
  homeDirectory,
  on_open_directory,
}: {
  project_id: string;
  current_path: string;
  show_hidden: boolean;
  homeDirectory?: string;
  on_open_directory: (path: string) => void;
}) {
  const rootPath = getRootPath(current_path, homeDirectory);
  const fs = useFs({ project_id });
  const [childrenByPath, setChildrenByPath] = useState<
    Record<string, string[]>
  >({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>(() =>
    getDirectoryTreeExpandedKeys(project_id),
  );
  const [error, setError] = useState<string>("");
  const loadingPathsRef = useRef<Set<string>>(new Set());
  const loadedPathsRef = useRef<Set<string>>(new Set());
  const { manageStarredFiles } = useProjectContext();
  const { starred, setStarredPath } = manageStarredFiles;
  const handleToggleStar = useCallback(
    (path: string, starredValue: boolean) => {
      setStarredPath(path, starredValue);
    },
    [setStarredPath],
  );

  const loadPath = useCallback(
    async (path: string, force = false) => {
      if (rootPath == null) return;
      if (fs == null) return;
      if (!force && loadedPathsRef.current.has(path)) return;
      if (loadingPathsRef.current.has(path)) return;
      loadingPathsRef.current.add(path);
      try {
        const entries = (await fs.readdir(path, {
          withFileTypes: true,
        })) as unknown as DirectoryTreeDirent[];
        const dirs = entries
          .filter(
            (entry): entry is DirectoryTreeNamedDirent =>
              typeof entry.name === "string" &&
              typeof entry.isDirectory === "function" &&
              entry.isDirectory() &&
              entry.name !== "." &&
              entry.name !== ".." &&
              (show_hidden || !entry.name.startsWith(".")),
          )
          .map((entry) => misc.path_to_file(path, entry.name))
          .sort((a, b) => misc.cmp(a, b));
        setChildrenByPath((prev) => ({ ...prev, [path]: dirs }));
        loadedPathsRef.current.add(path);
        setError("");
      } catch (err) {
        setError(`${err}`);
      } finally {
        loadingPathsRef.current.delete(path);
      }
    },
    [fs, rootPath, show_hidden],
  );

  useEffect(() => {
    if (rootPath == null) return;
    setChildrenByPath({});
    loadedPathsRef.current = new Set();
    loadingPathsRef.current.clear();
    void loadPath(rootPath, true);
  }, [loadPath, rootPath]);

  useEffect(() => {
    if (rootPath == null) return;
    const ancestors = getAncestorPaths(rootPath, current_path);
    setExpandedKeys((prev) => Array.from(new Set([...prev, ...ancestors])));
    for (const path of ancestors) {
      void loadPath(path);
    }
  }, [current_path, loadPath, rootPath]);

  useEffect(() => {
    saveDirectoryTreeExpandedKeys(project_id, expandedKeys);
  }, [expandedKeys, project_id]);

  const treeData = useMemo<TreeDataNode[]>(() => {
    if (rootPath == null) return [];
    const starredSet = new Set(starred);
    const loadedPaths = loadedPathsRef.current;

    const build = (path: string): TreeDataNode => {
      const children = (childrenByPath[path] ?? []).map(build);
      return {
        key: path,
        title: (
          <DirectoryTreeNodeTitle
            project_id={project_id}
            path={path}
            label={
              path === rootPath
                ? rootLabel(rootPath, homeDirectory)
                : misc.path_split(path).tail
            }
            isRoot={path === rootPath}
            isStarred={starredSet.has(`${path}/`)}
            onToggleStar={handleToggleStar}
          />
        ),
        children,
        isLeaf: loadedPaths.has(path) && children.length === 0,
      };
    };

    return [build(rootPath)];
  }, [
    childrenByPath,
    homeDirectory,
    handleToggleStar,
    project_id,
    rootPath,
    starred,
  ]);

  const onExpand: TreeProps["onExpand"] = useCallback(
    (keys) => {
      const next = keys.map(String);
      setExpandedKeys(next);
      for (const key of next) {
        void loadPath(key);
      }
    },
    [loadPath],
  );

  const onSelect: TreeProps["onSelect"] = useCallback(
    (selectedKeys) => {
      const key = selectedKeys[0];
      if (key == null) return;
      on_open_directory(String(key));
    },
    [on_open_directory],
  );

  if (rootPath == null) return null;

  return (
    <div
      style={{
        width: "100%",
        flex: "1 1 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {starred.filter((path) => path.endsWith("/")).length > 0 && (
        <div style={{ flex: "0 0 auto", marginBottom: 8 }}>
          {starred
            .filter((path) => path.endsWith("/"))
            .map((path) => {
              const target = path.slice(0, -1);
              const label =
                target === rootPath
                  ? rootLabel(target, homeDirectory)
                  : misc.path_split(target).tail || target;
              return (
                <div
                  key={path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 6px",
                    cursor: "pointer",
                    borderRadius: 4,
                    background:
                      current_path === target ? COLORS.BLUE_LLL : undefined,
                  }}
                  onClick={() => on_open_directory(target)}
                >
                  <Icon
                    name="star-filled"
                    style={{ color: COLORS.STAR }}
                    onClick={(e) => {
                      if (!e) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setStarredPath(path, false);
                    }}
                  />
                  <span
                    title={target}
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
        </div>
      )}
      <div style={PANEL_STYLE}>
        <Tree
          showLine
          blockNode
          treeData={treeData}
          expandedKeys={expandedKeys}
          selectedKeys={[current_path]}
          onExpand={onExpand}
          onSelect={onSelect}
        />
      </div>
      {error && (
        <div
          style={{ color: COLORS.ANTD_RED, paddingTop: 8, fontSize: "11px" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
