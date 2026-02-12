/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { HomeOutlined } from "@ant-design/icons";
import { Breadcrumb, Button, Flex, Tooltip } from "antd";
import { dirname } from "path";

import {
  CSS,
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { DropdownMenu, Icon, type MenuItems } from "@cocalc/frontend/components";
import { isBackupsPath } from "@cocalc/util/consts/backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import { trunc_middle } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { lite } from "@cocalc/frontend/lite";
import { createPathSegmentLink } from "./path-segment-link";

interface Props {
  project_id: string;
  style?: React.CSSProperties;
  className?: string;
  mode?: "files" | "flyout";
  showSourceSelector?: boolean;
}

// This path consists of several PathSegmentLinks
export const PathNavigator: React.FC<Props> = React.memo(
  ({
    project_id,
    style,
    className = "cc-path-navigator",
    mode = "files",
    showSourceSelector = false,
  }: Readonly<Props>) => {
    const currentPathAbs = useTypedRedux({ project_id }, "current_path_abs");
    const historyPathAbs = useTypedRedux({ project_id }, "history_path_abs");
    const availableFeatures = useTypedRedux({ project_id }, "available_features");
    const liteHome = availableFeatures?.get("homeDirectory");
    const homePath =
      lite && typeof liteHome === "string" && liteHome.length > 0
        ? normalizeAbsolutePath(liteHome)
        : "/root";

    const normalizePathForNav = (path: string): string => {
      const normalized = path.replace(/^\/+/, "");
      const isTrashPath =
        normalized === ".trash" || normalized.startsWith(".trash/");
      if (
        path.startsWith(".") ||
        isBackupsPath(path) ||
        isSnapshotsPath(path) ||
        isTrashPath
      ) {
        return normalized;
      }
      return normalizeAbsolutePath(path, homePath);
    };

    const sourceForPath = (
      path: string,
    ): { key: "home" | "root" | "tmp" | "scratch"; rootPath: string } => {
      if (!path.startsWith("/")) {
        return { key: "home", rootPath: homePath };
      }
      if (homePath !== "/" && (path === homePath || path.startsWith(`${homePath}/`))) {
        return { key: "home", rootPath: homePath };
      }
      if (path === "/tmp" || path.startsWith("/tmp/")) {
        return { key: "tmp", rootPath: "/tmp" };
      }
      if (!lite && (path === "/scratch" || path.startsWith("/scratch/"))) {
        return { key: "scratch", rootPath: "/scratch" };
      }
      return { key: "root", rootPath: "/" };
    };

    const stripRootPrefix = (path: string, rootPath: string): string[] => {
      if (!path) return [];
      if (!path.startsWith("/")) {
        return path.split("/").filter(Boolean);
      }
      if (rootPath === "/") {
        return path.split("/").filter(Boolean);
      }
      if (path === rootPath) {
        return [];
      }
      if (path.startsWith(`${rootPath}/`)) {
        return path.slice(rootPath.length).split("/").filter(Boolean);
      }
      return path.split("/").filter(Boolean);
    };

    const currentPath = normalizePathForNav(
      currentPathAbs ?? homePath,
    );
    const historyPath = normalizePathForNav(
      historyPathAbs ?? currentPath,
    );
    const currentSource = sourceForPath(currentPath);
    const historySource = sourceForPath(historyPath);
    const historyInSameRoot = currentSource.rootPath === historySource.rootPath;
    const actions = useActions({ project_id });

    const sourceMenuItems: MenuItems = [
      {
        key: "home",
        label: "Home",
        onClick: () => actions?.open_directory(homePath, true, false),
      },
      {
        key: "root",
        label: "/",
        onClick: () => actions?.open_directory("/", true, false),
      },
      {
        key: "tmp",
        label: "/tmp",
        onClick: () => actions?.open_directory("/tmp", true, false),
      },
    ];
    if (!lite) {
      sourceMenuItems.push({
        key: "scratch",
        label: "/scratch",
        onClick: () => actions?.open_directory("/scratch", true, false),
      });
    }

    const sourceTitle =
      currentSource.key === "home"
        ? "Home"
        : currentSource.key === "root"
          ? "/"
          : currentSource.key === "tmp"
            ? "/tmp"
            : "/scratch";

    function make_path() {
      const v: any[] = [];

      const currentSegments = stripRootPrefix(currentPath, currentSource.rootPath);
      const historySegments = stripRootPrefix(
        historyInSameRoot ? historyPath : currentPath,
        currentSource.rootPath,
      );
      const currentPathDepth = currentSegments.length - 1;

      const homeStyle: CSS = {
        fontSize: style?.fontSize,
        fontWeight: "bold",
      } as const;

      const homeDisplay =
        currentSource.key === "home" && mode === "files" ? (
          <>
            <HomeOutlined style={homeStyle} />{" "}
            <span style={homeStyle}>Home</span>
          </>
        ) : currentSource.key === "home" ? (
          <HomeOutlined style={homeStyle} />
        ) : (
          <span style={homeStyle}>{currentSource.rootPath}</span>
        );

      const suppressRedundantRootSegment =
        showSourceSelector && currentSource.key === "root";

      if (!suppressRedundantRootSegment) {
        v.push(
          createPathSegmentLink({
            path: currentSource.rootPath,
            display: (
              <Tooltip
                title={
                  currentSource.key === "home"
                    ? "Go to home directory"
                    : `Go to ${currentSource.rootPath}`
                }
              >
                {homeDisplay}
              </Tooltip>
            ),
            full_name: currentSource.rootPath,
            key: 0,
            on_click: () =>
              actions?.open_directory(currentSource.rootPath, true, false),
            active: currentPath === currentSource.rootPath,
          }),
        );
      }

      const pathLen = currentPathDepth;
      const condense = mode === "flyout";

      historySegments.forEach((segment, i) => {
        const is_current = i === currentPathDepth;
        const is_history = i > currentPathDepth;
        const relativePath = historySegments
          .slice(0, i + 1 || undefined)
          .join("/");
        const path = historyPath.startsWith("/")
          ? normalizeAbsolutePath(relativePath, currentSource.rootPath)
          : relativePath;

        // don't show too much in flyout mode
        const hide =
          condense &&
          ((i < pathLen && i <= pathLen - 2) ||
            (i > pathLen && i >= pathLen + 2));

        v.push(
          // yes, must be called as a normal function.
          createPathSegmentLink({
            path,
            display: hide ? <>&bull;</> : trunc_middle(segment, 15),
            full_name: segment,
            key: i + 1,
            on_click: (path) => actions?.open_directory(path, true, false),
            active: is_current,
            history: is_history,
          }),
        );
      });
      return v;
    }

    function renderSourceSelector() {
      if (!showSourceSelector) return null;
      return (
        <DropdownMenu
          button
          showDown
          size={mode === "files" ? "middle" : "small"}
          title={sourceTitle}
          items={sourceMenuItems}
          style={{ marginRight: "6px", flexShrink: 0 }}
        />
      );
    }

    function renderUP() {
      const canGoUp = currentPath !== "/";

      return (
        <Button
          icon={<Icon name="arrow-circle-up" />}
          type="text"
          onClick={() => {
            if (!canGoUp) return;
            const parent = currentPath.startsWith(".")
              ? currentPath.split("/").slice(0, -1).join("/")
              : dirname(currentPath);
            const parentPath = parent.length === 0 ? "/" : parent;
            actions?.open_directory(parentPath, true, false);
          }}
          disabled={!canGoUp}
          title={canGoUp ? "Go up one directory" : "Already at root directory"}
        />
      );
    }

    // Background color is set via .cc-project-files-path-nav > nav
    // so that things look good even for multiline long paths.
    const bc = (
      <Breadcrumb style={style} className={className} items={make_path()} />
    );

    const pathBar = (
      <Flex align="center" style={{ width: "100%", minWidth: 0 }}>
        {renderSourceSelector()}
        <div style={{ flex: 1, minWidth: 0 }}>{bc}</div>
      </Flex>
    );
    return mode === "files" ? (
      <Flex justify="space-between" align="center" style={{ width: "100%" }}>
        <div style={{ flex: 1, minWidth: 0 }}>{pathBar}</div>
        {renderUP()}
      </Flex>
    ) : (
      pathBar
    );
  },
);
