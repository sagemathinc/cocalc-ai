/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { TabsProps } from "antd";
import { Avatar, Button, Divider, Popover, Select, Tabs, Tooltip } from "antd";
import {
  CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CSS,
  redux,
  useActions,
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { set_window_title } from "@cocalc/frontend/browser";
import { Icon, Loading } from "@cocalc/frontend/components";
import {
  SortableTab,
  SortableTabs,
  useItemContext,
  useSortable,
} from "@cocalc/frontend/components/sortable-tabs";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { ProjectAvatarImage } from "@cocalc/frontend/projects/project-avatar";
import { COMPUTE_STATES } from "@cocalc/util/schema";
import { COLORS } from "@cocalc/util/theme";
import { useProjectState } from "../project/page/project-state-hook";
import { useProjectHasInternetAccess } from "../project/settings/has-internet-access-hook";
import { useBookmarkedProjects } from "./use-bookmarked-projects";

const PROJECT_NAME_STYLE: CSS = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "200px",
} as const;

type ProjectsNavMode = "tabs" | "dropdown";

const PROJECT_NAV_MODE_KEY = "cocalc:projects-nav-mode";
const DEFAULT_PROJECT_NAV_MODE: ProjectsNavMode = "dropdown";

function getStoredProjectsNavMode(): ProjectsNavMode {
  if (typeof window === "undefined") return DEFAULT_PROJECT_NAV_MODE;
  const stored = window.localStorage.getItem(PROJECT_NAV_MODE_KEY);
  return stored === "tabs" || stored === "dropdown"
    ? stored
    : DEFAULT_PROJECT_NAV_MODE;
}

interface ProjectTabProps {
  project_id: string;
}

function useProjectStatusAlerts(project_id: string) {
  const [any_alerts, set_any_alerts] = useState<boolean>(false);
  const project_status = useTypedRedux({ project_id }, "status");
  const any = project_status?.get("alerts").size > 0;
  useMemo(() => {
    set_any_alerts(any);
  }, [any]);
  return any_alerts;
}

function ProjectTab({ project_id }: ProjectTabProps) {
  const { width } = useItemContext();

  // determine, if the "no internet" icon + text is shown – only known for sure, if project is running
  const status = useProjectState(project_id);
  const isRunning = useMemo(
    () => status.get("state") === "running",
    [status.get("state")],
  );
  const hasInternet = useProjectHasInternetAccess(project_id);
  const showNoInternet = isRunning && !hasInternet;

  const { active } = useSortable({ id: project_id });
  const other_settings = useTypedRedux("account", "other_settings");
  const active_top_tab = useTypedRedux("page", "active_top_tab");
  const project = useRedux(["projects", "project_map", project_id]);
  const pageActions = useActions("page");
  const public_project_titles = useTypedRedux(
    "projects",
    "public_project_titles",
  );
  const any_alerts = useProjectStatusAlerts(project_id);

  const title = project?.get("title") ?? public_project_titles?.get(project_id);
  if (title == null) {
    if (active_top_tab == project_id) {
      set_window_title("Loading");
    }
    return <Loading key={project_id} />;
  }

  if (active_top_tab == project_id) {
    set_window_title(title);
  }

  const project_state = project?.getIn(["state", "state"]);

  const icon =
    any_alerts && project_state === "running" ? (
      <Icon name={"exclamation-triangle"} style={{ color: COLORS.BS_RED }} />
    ) : (
      <Icon name={COMPUTE_STATES[project_state]?.icon ?? "bullhorn"} />
    );

  function click_title(e) {
    // we intercept a click with a modification key in order to open that project in a new window
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      e.stopPropagation();
      e.preventDefault();
      const actions = redux.getProjectActions(project_id);
      actions.open_file({ path: "", new_browser_window: true });
    }
  }

  function noInternetInfo(mode: "tooltip" | "popover") {
    if (!showNoInternet) return;
    const fontStyle = {
      color: mode === "popover" ? COLORS.ANTD_RED_WARN : "white",
    };
    return (
      <>
        <div style={fontStyle}>
          This workspace does not have access to the internet.
        </div>
        {mode === "popover" ? <hr /> : null}
      </>
    );
  }

  function renderContent() {
    return (
      <div style={{ maxWidth: "400px", maxHeight: "50vh", overflow: "auto" }}>
        {noInternetInfo("popover")}
        <ProjectAvatarImage
          project_id={project_id}
          size={120}
          style={{ textAlign: "center" }}
        />
        <StaticMarkdown
          style={{ display: "inline-block" }}
          value={project?.get("description") ?? ""}
        />
        <hr />
        <div style={{ color: COLORS.GRAY }}>
          Hint: Shift+click any workspace or file tab to open it in new window.
        </div>
      </div>
    );
  }

  function renderNoInternet() {
    if (!showNoInternet) return;
    const noInternet = (
      <Icon name="global" style={{ color: COLORS.ANTD_RED_WARN }} />
    );
    if (other_settings.get("hide_project_popovers")) {
      return <Tooltip title={noInternetInfo("tooltip")}>{noInternet}</Tooltip>;
    } else {
      return noInternet;
    }
  }

  function renderAvatar() {
    const avatar = project?.get("avatar_image_tiny");
    const color = project?.get("color");

    if (avatar) {
      // Avatar exists: show it with colored border
      return (
        <Avatar
          style={{
            marginTop: "-2px",
            border: color ? `2px solid ${color}` : undefined,
          }}
          shape="circle"
          icon={<img src={project.get("avatar_image_tiny")} />}
          size={20}
        />
      );
    } else if (color) {
      // No avatar but has color: show colored circle
      return (
        <Avatar
          style={{
            marginTop: "-2px",
            backgroundColor: color,
          }}
          shape="circle"
          size={20}
        />
      );
    }

    return undefined;
  }

  function onMouseUp(e: React.MouseEvent) {
    // if middle mouse button has been clicked, close the project
    if (e.button === 1) {
      e.stopPropagation();
      e.preventDefault();
      pageActions.close_project_tab(project_id);
    }
  }

  const body = (
    <div
      onMouseUp={onMouseUp}
      style={{
        marginTop: "-1px" /* compensate for border */,
        ...(width != null ? { width } : undefined),
      }}
    >
      <div style={PROJECT_NAME_STYLE} onClick={click_title}>
        {icon}
        {renderNoInternet()}
        {renderAvatar()}{" "}
        <span style={{ marginLeft: 5, position: "relative" }}>{title}</span>
      </div>
    </div>
  );
  if (IS_MOBILE || other_settings.get("hide_project_popovers")) {
    return body;
  }
  return (
    <Popover
      zIndex={10000}
      title={
        <StaticMarkdown style={{ display: "inline-block" }} value={title} />
      }
      content={renderContent()}
      placement="bottom"
      open={active != null ? false : undefined}
      mouseEnterDelay={0.9}
    >
      {body}
    </Popover>
  );
}

interface ProjectsNavProps {
  style?: CSSProperties;
  height: number; // px
}

export function ProjectsNav(props: ProjectsNavProps) {
  const { style, height } = props;
  const actions = useActions("page");
  const projectActions = useActions("projects");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const openProjects = useTypedRedux("projects", "open_projects");
  const projectMap = useTypedRedux("projects", "project_map");
  const publicProjectTitles = useTypedRedux(
    "projects",
    "public_project_titles",
  );
  const { bookmarkedProjects } = useBookmarkedProjects();
  //const project_map = useTypedRedux("projects", "project_map");
  const [mode, setMode] = useState<ProjectsNavMode>(
    getStoredProjectsNavMode,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const selectRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PROJECT_NAV_MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (mode !== "dropdown") {
          setMode("dropdown");
        }
        setDropdownOpen(true);
        setTimeout(() => selectRef.current?.focus?.(), 0);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [mode]);

  const items: TabsProps["items"] = useMemo(() => {
    if (openProjects == null) return [];
    return openProjects.toJS().map((project_id) => {
      return {
        label: <ProjectTab project_id={project_id} />,
        key: project_id,
      };
    });
  }, [openProjects]);

  const project_ids: string[] = useMemo(() => {
    if (openProjects == null) return [];
    return openProjects.toJS().map((project_id) => project_id);
  }, [openProjects]);

  const openProjectIds = project_ids;
  const openProjectSet = useMemo(
    () => new Set(openProjectIds),
    [openProjectIds],
  );

  const activeProjectId = useMemo(() => {
    if (openProjectIds.includes(activeTopTab)) return activeTopTab;
    return openProjectIds[0];
  }, [activeTopTab, openProjectIds]);

  const recentProjectIds = useMemo(() => {
    if (!projectMap) return [];
    const ids = projectMap.keySeq().toArray();
    ids.sort((a, b) => {
      const aTime = projectMap.getIn([a, "last_edited"]);
      const bTime = projectMap.getIn([b, "last_edited"]);
      const aMs =
        typeof aTime === "string" ||
        typeof aTime === "number" ||
        aTime instanceof Date
          ? new Date(aTime).getTime()
          : 0;
      const bMs =
        typeof bTime === "string" ||
        typeof bTime === "number" ||
        bTime instanceof Date
          ? new Date(bTime).getTime()
          : 0;
      return bMs - aMs;
    });
    return ids.filter((id) => !openProjectSet.has(id)).slice(0, 10);
  }, [projectMap, openProjectSet]);

  const starredProjectIds = useMemo(() => {
    if (!projectMap || !bookmarkedProjects) return [];
    return bookmarkedProjects.filter((id) => {
      if (!projectMap.get(id)) return false;
      return !openProjectSet.has(id);
    });
  }, [bookmarkedProjects, openProjectSet, projectMap]);

  function getProjectTitle(project_id: string): string {
    return (
      projectMap?.getIn([project_id, "title"]) ??
      publicProjectTitles?.get(project_id) ??
      "Untitled workspace"
    );
  }

  function onEdit(project_id: string, action: "add" | "remove") {
    if (action === "add") {
      actions.set_active_tab("projects");
    } else {
      // close given project
      actions.close_project_tab(project_id);
    }
  }

  function onDragEnd(event) {
    const { active, over } = event;
    if (active == null || over == null || active.id == over.id) return;
    projectActions.move_project_tab({
      old_index: project_ids.indexOf(active.id),
      new_index: project_ids.indexOf(over.id),
    });
  }

  function onDragStart(event) {
    if (event?.active?.id != activeTopTab) {
      actions.set_active_tab(event?.active?.id);
    }
  }

  function renderTabBar0(tabBarProps, DefaultTabBar) {
    return (
      <DefaultTabBar {...tabBarProps}>
        {(node) => {
          const project_id = node.key;
          const isActive = project_id === activeTopTab;

          const wrapperStyle: CSS = {
            border: isActive
              ? `2px solid ${"#d3d3d3"}`
              : `2px solid  ${"transparent"}`,
            borderRadius: "8px",
          };

          // Kept for reference, this allows to tweak the node props directly
          // const styledNode = cloneElement(node, {
          //   style: {
          //     ...node.props.style,
          //     backgroundColor: wrapperStyle.backgroundColor,
          //   },
          // });

          return (
            <SortableTab key={node.key} id={node.key} style={wrapperStyle}>
              {node}
            </SortableTab>
          );
        }}
      </DefaultTabBar>
    );
  }

  function renderDropdownNav() {
    const normalizedSearch = searchValue.trim().toLowerCase();
    const matchesSearch = (label: string) =>
      !normalizedSearch || label.toLowerCase().includes(normalizedSearch);
    const openOptions = openProjectIds.map((project_id) => ({
      value: project_id,
      label: getProjectTitle(project_id),
      closable: true,
    })).filter((option) => matchesSearch(option.label));
    const recentOptions = recentProjectIds.map((project_id) => ({
      value: project_id,
      label: getProjectTitle(project_id),
    })).filter((option) => matchesSearch(option.label));
    const starredOptions = starredProjectIds.map((project_id) => ({
      value: project_id,
      label: getProjectTitle(project_id),
    })).filter((option) => matchesSearch(option.label));

    const groupedOptions = [
      ...(openOptions.length > 0
        ? [{ label: "Open workspaces", options: openOptions }]
        : []),
      ...(starredOptions.length > 0
        ? [{ label: "Starred workspaces", options: starredOptions }]
        : []),
      ...(recentOptions.length > 0
        ? [{ label: "Recent workspaces", options: recentOptions }]
        : []),
    ];

    const hasResults = groupedOptions.some(
      (group) => group.options && group.options.length > 0,
    );

    const renderOptionItem = (option) => {
      const project_id = option?.value;
      const closable = option?.closable;
      return (
        <div
          key={project_id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 6,
            cursor: "pointer",
          }}
          onClick={() => {
            projectActions.open_project({
              project_id,
              switch_to: true,
            });
            setDropdownOpen(false);
          }}
        >
          <span
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={option?.label}
          >
            {option?.label}
          </span>
          {closable ? (
            <Button
              size="small"
              type="text"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                actions.close_project_tab(project_id);
              }}
            >
              <Icon name="times" />
            </Button>
          ) : null}
        </div>
      );
    };

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          height: `${height}px`,
          paddingRight: "8px",
        }}
      >
        <Tooltip
          title={
            mode === "tabs" ? "Switch to workspace list" : "Switch to tabs"
          }
        >
          <Button
            size="small"
            onClick={() => setMode(mode === "tabs" ? "dropdown" : "tabs")}
          >
            {mode === "tabs" ? "Tabs" : "List"}
          </Button>
        </Tooltip>
        <Select
          ref={selectRef}
          size="middle"
          open={dropdownOpen}
          onDropdownVisibleChange={(open) => {
            setDropdownOpen(open);
            if (!open) {
              setSearchValue("");
            }
          }}
          style={{ minWidth: 260, maxWidth: 400 }}
          placeholder="Switch workspace…"
          value={activeProjectId}
          showSearch
          optionLabelProp="label"
          filterOption={false}
          searchValue={searchValue}
          onSearch={setSearchValue}
          onClear={() => setSearchValue("")}
          allowClear
          options={groupedOptions}
          dropdownRender={(menu) => (
            <>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {hasResults ? (
                  groupedOptions.map((group) => (
                    <div key={group.label} style={{ padding: "4px 0" }}>
                      <div
                        style={{
                          padding: "6px 8px",
                          fontSize: 12,
                          color: "#666",
                        }}
                      >
                        {group.label}
                      </div>
                      {group.options.map((option) =>
                        renderOptionItem(option),
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: "8px 12px", color: "#888" }}>
                    No workspaces found
                  </div>
                )}
              </div>
              <Divider style={{ margin: "6px 0" }} />
              <div style={{ padding: "4px 8px" }}>
                <Button
                  size="small"
                  onClick={() => actions.set_active_tab("projects")}
                >
                  All workspaces…
                </Button>
              </div>
            </>
          )}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        overflow: "hidden",
        height: `${height}px`,
        ...style,
      }}
    >
      {mode === "dropdown" ? (
        renderDropdownNav()
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            height: `${height}px`,
            paddingTop: "2px",
            paddingBottom: "2px",
          }}
        >
          <div style={{ padding: "0 8px", flex: "0 0 auto" }}>
            <Tooltip
              title={
                mode === "tabs" ? "Switch to workspace list" : "Switch to tabs"
              }
            >
              <Button
                size="small"
                onClick={() =>
                  setMode(mode === "tabs" ? "dropdown" : "tabs")
                }
              >
                {mode === "tabs" ? "Tabs" : "List"}
              </Button>
            </Tooltip>
          </div>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {items.length > 0 && (
              <SortableTabs
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                items={project_ids}
              >
                <Tabs
                  animated={false}
                  moreIcon={
                    <Icon style={{ fontSize: "18px" }} name="ellipsis" />
                  }
                  size="small"
                  tabBarStyle={{ margin: 0 }}
                  activeKey={activeTopTab}
                  onEdit={onEdit}
                  onChange={(project_id) => {
                    actions.set_active_tab(project_id);
                  }}
                  type={"editable-card"}
                  renderTabBar={renderTabBar0}
                  items={items}
                />
              </SortableTabs>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
