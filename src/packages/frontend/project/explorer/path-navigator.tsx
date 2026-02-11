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
import { Icon } from "@cocalc/frontend/components";
import { trunc_middle } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { lite } from "@cocalc/frontend/lite";
import { createPathSegmentLink } from "./path-segment-link";

interface Props {
  project_id: string;
  style?: React.CSSProperties;
  className?: string;
  mode?: "files" | "flyout";
}

// This path consists of several PathSegmentLinks
export const PathNavigator: React.FC<Props> = React.memo(
  ({
    project_id,
    style,
    className = "cc-path-navigator",
    mode = "files",
  }: Readonly<Props>) => {
    const currentPathAbs = useTypedRedux({ project_id }, "current_path_abs");
    const currentPathLegacy = useTypedRedux({ project_id }, "current_path");
    const historyPathAbs = useTypedRedux({ project_id }, "history_path_abs");
    const historyPathLegacy = useTypedRedux({ project_id }, "history_path");
    const availableFeatures = useTypedRedux({ project_id }, "available_features");
    const liteHome = availableFeatures?.get("homeDirectory");
    const homePath =
      lite && typeof liteHome === "string" && liteHome.length > 0
        ? normalizeAbsolutePath(liteHome)
        : "/root";

    const normalizePathForNav = (path: string): string => {
      if (path.startsWith(".")) return path;
      return normalizeAbsolutePath(path, homePath);
    };

    const currentPath = normalizePathForNav(
      currentPathAbs ?? currentPathLegacy ?? homePath,
    );
    const historyPath = normalizePathForNav(
      historyPathAbs ?? historyPathLegacy ?? currentPath,
    );
    const actions = useActions({ project_id });

    function make_path() {
      const v: any[] = [];

      const currentPathInHome =
        currentPath === homePath || currentPath.startsWith(`${homePath}/`);
      const historyPathInHome =
        historyPath === homePath || historyPath.startsWith(`${homePath}/`);
      const currentSegments = (
        currentPathInHome && homePath !== "/"
          ? currentPath.slice(homePath.length)
          : currentPath
      )
        .split("/")
        .filter(Boolean);
      const historySegments = (
        historyPathInHome && homePath !== "/"
          ? historyPath.slice(homePath.length)
          : historyPath
      )
        .split("/")
        .filter(Boolean);
      const currentPathDepth = currentSegments.length - 1;

      const homeStyle: CSS = {
        fontSize: style?.fontSize,
        fontWeight: "bold",
      } as const;

      const homeDisplay =
        mode === "files" ? (
          <>
            <HomeOutlined style={homeStyle} />{" "}
            <span style={homeStyle}>Home</span>
          </>
        ) : (
          <HomeOutlined style={homeStyle} />
        );

      v.push(
        createPathSegmentLink({
          path: homePath,
          display: (
            <Tooltip title="Go to home directory">{homeDisplay}</Tooltip>
          ),
          full_name: homePath,
          key: 0,
          on_click: () => actions?.open_directory(homePath, true, false),
          active: currentPath === homePath,
        }),
      );

      const pathLen = currentPathDepth;
      const condense = mode === "flyout";

      historySegments.forEach((segment, i) => {
        const is_current = i === currentPathDepth;
        const is_history = i > currentPathDepth;
        const relativePath = historySegments
          .slice(0, i + 1 || undefined)
          .join("/");
        const path =
          historyPathInHome && homePath !== "/"
            ? normalizeAbsolutePath(relativePath, homePath)
            : historyPath.startsWith("/")
              ? `/${relativePath}`
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
            const parentPath = parent === "." ? homePath : parent;
            actions?.open_directory(parentPath, true, false);
          }}
          disabled={!canGoUp}
          title={canGoUp ? "Go up one directory" : "Already at home directory"}
        />
      );
    }

    // Background color is set via .cc-project-files-path-nav > nav
    // so that things look good even for multiline long paths.
    const bc = (
      <Breadcrumb style={style} className={className} items={make_path()} />
    );
    return mode === "files" ? (
      <Flex justify="space-between" align="center" style={{ width: "100%" }}>
        <div style={{ flex: 1, minWidth: 0 }}>{bc}</div>
        {renderUP()}
      </Flex>
    ) : (
      bc
    );
  },
);
