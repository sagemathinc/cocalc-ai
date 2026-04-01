/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { HomeOutlined } from "@ant-design/icons";
import { Breadcrumb, Button, Dropdown, Flex, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { dirname } from "path";

import {
  CSS,
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  DropdownMenu,
  Icon,
  type MenuItems,
} from "@cocalc/frontend/components";
import { isBackupsPath } from "@cocalc/util/consts/backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import { trunc_middle } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { lite } from "@cocalc/frontend/lite";
import { createPathSegmentLink } from "./path-segment-link";

interface Props {
  project_id: string;
  style?: React.CSSProperties;
  className?: string;
  mode?: "files" | "flyout";
  showSourceSelector?: boolean;
  currentPath?: string;
  historyPath?: string;
  onNavigate?: (path: string) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  backHistory?: string[];
  forwardHistory?: string[];
}

const LONG_PRESS_MS = 400;
const DROPDOWN_MENU_STYLE: React.CSSProperties = {
  maxHeight: "30vh",
  overflowY: "auto",
  overflowX: "hidden",
  maxWidth: 350,
};

function historyMenuItems(
  paths: string[],
  navigate: (path: string) => void,
): MenuProps["items"] {
  return paths.map((path, index) => ({
    key: `${index}-${path}`,
    label: (
      <span
        title={path || "Home"}
        style={{
          display: "block",
          maxWidth: 320,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {path || "Home"}
      </span>
    ),
    onClick: () => navigate(path),
  }));
}

function LongPressButton({
  icon,
  disabled,
  onClick,
  title,
  dropdownItems,
}: {
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  dropdownItems?: MenuProps["items"];
}) {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = React.useRef(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);

  React.useEffect(() => {
    if (!dropdownOpen) return;

    function handlePointerUpOnDocument(e: PointerEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const menuItem = el?.closest?.(
        ".ant-dropdown-menu-item",
      ) as HTMLElement | null;
      if (menuItem) {
        menuItem.click();
        return;
      }
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }

    const timer = setTimeout(
      () => document.addEventListener("pointerup", handlePointerUpOnDocument),
      0,
    );
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerup", handlePointerUpOnDocument);
    };
  }, [dropdownOpen]);

  React.useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handlePointerDown = () => {
    if (disabled) return;
    longPressedRef.current = false;
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      if ((dropdownItems?.length ?? 0) > 0) {
        setDropdownOpen(true);
      }
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!longPressedRef.current && !disabled) {
      onClick();
    }
  };

  const handlePointerLeave = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const button = (
    <Tooltip title={dropdownOpen ? "" : title}>
      <Button
        icon={icon}
        type="text"
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onClick={(e) => e.preventDefault()}
      />
    </Tooltip>
  );

  if ((dropdownItems?.length ?? 0) === 0) {
    return button;
  }

  return (
    <div ref={wrapperRef} style={{ display: "inline-block" }}>
      <Dropdown
        open={dropdownOpen}
        onOpenChange={setDropdownOpen}
        trigger={[]}
        menu={{
          items: dropdownItems,
          style: DROPDOWN_MENU_STYLE,
          onClick: () => setDropdownOpen(false),
        }}
      >
        {button}
      </Dropdown>
    </div>
  );
}

// This path consists of several PathSegmentLinks
export const PathNavigator: React.FC<Props> = React.memo(
  ({
    project_id,
    style,
    className = "cc-path-navigator",
    mode = "files",
    showSourceSelector = false,
    currentPath: currentPathOverride,
    historyPath: historyPathOverride,
    onNavigate,
    canGoBack,
    canGoForward,
    onGoBack,
    onGoForward,
    backHistory = [],
    forwardHistory = [],
  }: Readonly<Props>) => {
    const currentPathAbs = useTypedRedux({ project_id }, "current_path_abs");
    const historyPathAbs = useTypedRedux({ project_id }, "history_path_abs");
    const availableFeatures = useTypedRedux(
      { project_id },
      "available_features",
    );
    const resolvedHome = availableFeatures?.get("homeDirectory");
    const homePath =
      typeof resolvedHome === "string" && resolvedHome.length > 0
        ? normalizeAbsolutePath(resolvedHome)
        : getProjectHomeDirectory(project_id);
    const navigate = (path: string) => {
      if (onNavigate) {
        onNavigate(path);
      } else {
        actions?.open_directory(path, true, false);
      }
    };

    const normalizePathForNav = (path: string): string => {
      const normalized = path.replace(/^\/+/, "");
      if (
        path.startsWith(".") ||
        isBackupsPath(path) ||
        isSnapshotsPath(path)
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
      if (
        homePath !== "/" &&
        (path === homePath || path.startsWith(`${homePath}/`))
      ) {
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
      currentPathOverride ?? currentPathAbs ?? homePath,
    );
    const historyPath = normalizePathForNav(
      historyPathOverride ?? historyPathAbs ?? currentPath,
    );
    const currentSource = sourceForPath(currentPath);
    const historySource = sourceForPath(historyPath);
    const historyInSameRoot = currentSource.rootPath === historySource.rootPath;
    const actions = useActions({ project_id });

    const sourceMenuItems: MenuItems = [
      {
        key: "home",
        label: "Home",
        onClick: () => navigate(homePath),
      },
      {
        key: "root",
        label: "/",
        onClick: () => navigate("/"),
      },
      {
        key: "tmp",
        label: "/tmp",
        onClick: () => navigate("/tmp"),
      },
    ];
    if (!lite) {
      sourceMenuItems.push({
        key: "scratch",
        label: "/scratch",
        onClick: () => navigate("/scratch"),
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

      const currentSegments = stripRootPrefix(
        currentPath,
        currentSource.rootPath,
      );
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
            on_click: () => navigate(currentSource.rootPath),
            active: currentPath === currentSource.rootPath,
            dropPath: currentSource.rootPath,
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
            on_click: (path) => navigate(path),
            active: is_current,
            history: is_history,
            dropPath: path,
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
            navigate(parentPath);
          }}
          disabled={!canGoUp}
          title={canGoUp ? "Go up one directory" : "Already at root directory"}
        />
      );
    }

    function renderBackForward() {
      if (!onGoBack && !onGoForward) return null;
      return (
        <>
          <LongPressButton
            icon={<Icon name="chevron-left" />}
            disabled={!canGoBack}
            onClick={() => onGoBack?.()}
            title="Back"
            dropdownItems={historyMenuItems(backHistory, navigate)}
          />
          <LongPressButton
            icon={<Icon name="chevron-right" />}
            disabled={!canGoForward}
            onClick={() => onGoForward?.()}
            title="Forward"
            dropdownItems={historyMenuItems(forwardHistory, navigate)}
          />
        </>
      );
    }

    // Background color is set via .cc-project-files-path-nav > nav
    // so that things look good even for multiline long paths.
    const bc = (
      <Breadcrumb style={style} className={className} items={make_path()} />
    );

    const pathBar = (
      <Flex align="center" style={{ width: "100%", minWidth: 0 }}>
        {renderBackForward()}
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
