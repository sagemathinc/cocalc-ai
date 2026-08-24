/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { TabsProps } from "antd";
import { Button, Divider, Popover, Select, Tabs } from "antd";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CSSProperties,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CSS,
  redux,
  useAccountOtherSetting,
  useActions,
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { set_window_title } from "@cocalc/frontend/browser";
import { Icon, Loading, Tooltip } from "@cocalc/frontend/components";
import LazyMarkdown from "@cocalc/frontend/components/lazy-markdown";
import {
  AccessibleAddTabIcon,
  SortableTab,
  SortableTabs,
  useItemContext,
  useSortable,
} from "@cocalc/frontend/components/sortable-tabs";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { ProjectAvatarImage } from "@cocalc/frontend/projects/project-avatar";
import {
  ProjectStatusAlertDetails,
  visibleProjectStatusAlerts,
} from "@cocalc/frontend/project/project-status-alerts";
import { COLORS } from "@cocalc/util/theme";
import { useProjectState } from "../project/page/project-state-hook";
import { useProjectHasInternetAccess } from "../project/settings/has-internet-access-hook";
import { shouldOpenProjectsNavShortcut } from "./projects-nav-shortcut";
import {
  getStoredProjectsNavMode,
  storeProjectsNavMode,
  type ProjectsNavMode,
} from "./projects-nav-mode";
import {
  ProjectThemeAvatar,
  projectThemeColor,
  projectThemeFromProject,
} from "./theme";
import { useBookmarkedProjects } from "./use-bookmarked-projects";
import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";

const NewProjectCreator = lazyWithRetry(
  async () => ({
    default: (await import("./create-project")).NewProjectCreator,
  }),
  "project navigation create dialog",
);

const PROJECT_NAME_STYLE: CSS = {
  alignItems: "center",
  display: "flex",
  gap: 4,
  overflow: "hidden",
  minWidth: 0,
  whiteSpace: "nowrap",
  width: "100%",
} as const;

const PROJECT_TITLE_FADE_STYLE: CSS = {
  display: "block",
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  WebkitMaskImage:
    "linear-gradient(90deg, #000 calc(100% - 10px), transparent)",
  maskImage: "linear-gradient(90deg, #000 calc(100% - 10px), transparent)",
} as const;

interface ProjectTabProps {
  project_id: string;
}

function useProjectStatusAlerts(project_id: string) {
  const project_status = useTypedRedux({ project_id }, "status");
  return useMemo(
    () => visibleProjectStatusAlerts(project_status),
    [project_status],
  );
}

function ProjectStarButton({
  project_id,
  starred,
  onToggleStar,
}: {
  project_id: string;
  starred: boolean;
  onToggleStar: (project_id: string) => void;
}) {
  const label = starred ? "Unstar project" : "Star project";
  return (
    <Tooltip title={label}>
      <Button
        aria-label={label}
        size="small"
        type="text"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleStar(project_id);
        }}
        style={{
          color: starred ? COLORS.STAR : COLORS.GRAY_L,
          height: 22,
          lineHeight: "20px",
          padding: "0 2px",
        }}
      >
        <Icon name={starred ? "star-filled" : "star"} />
      </Button>
    </Tooltip>
  );
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
  const hideProjectPopovers =
    useAccountOtherSetting<boolean>("hide_project_popovers") ?? false;
  const active_top_tab = useTypedRedux("page", "active_top_tab");
  const project = useRedux(["projects", "project_map", project_id]);
  const pageActions = useActions("page");
  const public_project_titles = useTypedRedux(
    "projects",
    "public_project_titles",
  );
  const statusAlerts = useProjectStatusAlerts(project_id);

  const title = project?.get("title") ?? public_project_titles?.get(project_id);
  useEffect(() => {
    if (active_top_tab !== project_id) return;
    set_window_title(title ?? "Loading");
  }, [active_top_tab, project_id, title]);

  if (title == null) {
    return <Loading key={project_id} />;
  }

  async function click_title(e) {
    // we intercept a click with a modification key in order to open that project in a new window
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      e.stopPropagation();
      e.preventDefault();
      await ensureProjectReduxRuntime();
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
          This project does not have access to the internet.
        </div>
        {mode === "popover" ? <hr /> : null}
      </>
    );
  }

  async function openProjectInfo(event?: React.MouseEvent<HTMLElement>) {
    event?.stopPropagation();
    event?.preventDefault();
    await pageActions.set_active_tab(project_id);
    await ensureProjectReduxRuntime();
    redux.getProjectActions(project_id)?.set_active_tab("info");
  }

  function renderContent() {
    return (
      <div style={{ maxWidth: "400px", maxHeight: "50vh", overflow: "auto" }}>
        {noInternetInfo("popover")}
        {statusAlerts.length > 0 ? (
          <>
            <ProjectStatusAlertDetails
              alerts={statusAlerts}
              onOpenInfo={openProjectInfo}
            />
            <hr />
          </>
        ) : null}
        <ProjectAvatarImage
          project_id={project_id}
          size={120}
          style={{ textAlign: "center" }}
        />
        <LazyMarkdown
          style={{ display: "inline-block" }}
          value={project?.get("description") ?? ""}
        />
        <hr />
        <div style={{ color: COLORS.GRAY }}>
          Hint: Shift+click any project or file tab to open it in new window.
        </div>
      </div>
    );
  }

  function renderNoInternet() {
    if (!showNoInternet) return;
    const noInternet = (
      <Icon name="global" style={{ color: COLORS.ANTD_RED_WARN }} />
    );
    if (hideProjectPopovers) {
      return <Tooltip title={noInternetInfo("tooltip")}>{noInternet}</Tooltip>;
    } else {
      return noInternet;
    }
  }

  function renderAvatar() {
    return (
      <ProjectThemeAvatar
        project={project}
        size={20}
        border
        style={{ flex: "0 0 auto", marginTop: "-2px" }}
      />
    );
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
        minWidth: 0,
        overflow: "hidden",
        ...(width != null ? { width } : undefined),
      }}
    >
      <div style={PROJECT_NAME_STYLE} onClick={click_title}>
        {renderNoInternet()}
        {renderAvatar()} <span style={PROJECT_TITLE_FADE_STYLE}>{title}</span>
        <span
          aria-hidden="true"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            pageActions.close_project_tab(project_id);
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          style={{ cursor: "pointer", flex: "0 0 auto" }}
          title={`Close ${title}`}
        >
          <Icon name="times" />
        </span>
      </div>
    </div>
  );
  if (IS_MOBILE || hideProjectPopovers) {
    return body;
  }
  return (
    <Popover
      zIndex={10000}
      title={() => (
        <LazyMarkdown style={{ display: "inline-block" }} value={title} />
      )}
      content={renderContent}
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
  onModeChange?: (mode: ProjectsNavMode) => void;
}

export function ProjectsNav(props: ProjectsNavProps) {
  const { style, height, onModeChange } = props;
  const actions = useActions("page");
  const projectActions = useActions("projects");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const openProjects = useTypedRedux("projects", "open_projects");
  const projectMap = useTypedRedux("projects", "project_map");
  const publicProjectTitles = useTypedRedux(
    "projects",
    "public_project_titles",
  );
  const { bookmarkedProjects, setProjectBookmarked } = useBookmarkedProjects();
  //const project_map = useTypedRedux("projects", "project_map");
  const [mode, setMode] = useState<ProjectsNavMode>(getStoredProjectsNavMode);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const createPanelMounted = useRef(false);
  if (createPanelOpen) createPanelMounted.current = true;
  const selectRef = useRef<any>(null);

  useEffect(() => {
    storeProjectsNavMode(mode);
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (!shouldOpenProjectsNavShortcut(e)) return;
      e.preventDefault();
      if (mode !== "dropdown") {
        setMode("dropdown");
      }
      setDropdownOpen(true);
      setTimeout(() => selectRef.current?.focus?.(), 0);
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [mode]);

  const bookmarkedProjectSet = useMemo(
    () => new Set(bookmarkedProjects ?? []),
    [bookmarkedProjects],
  );

  function isProjectStarred(project_id: string): boolean {
    return bookmarkedProjectSet.has(project_id);
  }

  function toggleProjectStar(project_id: string) {
    setProjectBookmarked(project_id, !isProjectStarred(project_id));
  }

  const items: TabsProps["items"] = useMemo(() => {
    if (openProjects == null) return [];
    return openProjects.toJS().map((project_id) => {
      return {
        closable: false,
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
      "Untitled project"
    );
  }

  function getProjectVisual(project_id: string) {
    const project = projectMap?.get(project_id);
    const title = getProjectTitle(project_id);
    return {
      title,
      label: title,
      theme: projectThemeFromProject(project),
      color: projectThemeColor(project),
    };
  }

  function onEdit(project_id: string, action: "add" | "remove") {
    if (action === "add") {
      setCreatePanelOpen(true);
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

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Delete") return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.getAttribute("role") !== "tab") return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const index = tabs.indexOf(event.target);
    const project_id = project_ids[index];
    if (!project_id) return;
    event.preventDefault();
    event.stopPropagation();
    actions.close_project_tab(project_id);
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
    const renderLabelNode = (option) => {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <ProjectThemeAvatar
            theme={option.theme}
            size={18}
            border={!!option?.color}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {option?.title}
          </span>
        </span>
      );
    };
    const makeOption = (project_id: string, closable?: boolean) => {
      const visual = getProjectVisual(project_id);
      const labelNode = renderLabelNode(visual);
      return {
        value: project_id,
        ...visual,
        label: labelNode,
        labelText: visual.title,
        starred: isProjectStarred(project_id),
        closable,
      };
    };

    const openOptions = openProjectIds
      .map((project_id) => makeOption(project_id, true))
      .filter((option) => matchesSearch(option.title));
    const recentOptions = recentProjectIds
      .map((project_id) => makeOption(project_id))
      .filter((option) => matchesSearch(option.title));
    const starredOptions = starredProjectIds
      .map((project_id) => makeOption(project_id))
      .filter((option) => matchesSearch(option.title));

    const groupedOptions = [
      ...(openOptions.length > 0
        ? [{ label: "Open projects", options: openOptions }]
        : []),
      ...(starredOptions.length > 0
        ? [{ label: "Starred projects", options: starredOptions }]
        : []),
      ...(recentOptions.length > 0
        ? [{ label: "Recent projects", options: recentOptions }]
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
            title={option?.title}
          >
            {renderLabelNode(option)}
          </span>
          <ProjectStarButton
            project_id={project_id}
            starred={!!option?.starred}
            onToggleStar={toggleProjectStar}
          />
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
          title={mode === "tabs" ? "Switch to project list" : "Switch to tabs"}
        >
          <Button
            size="small"
            onClick={() => setMode(mode === "tabs" ? "dropdown" : "tabs")}
          >
            {mode === "tabs" ? "Tabs" : "List"}
          </Button>
        </Tooltip>
        {activeProjectId ? (
          <ProjectStarButton
            project_id={activeProjectId}
            starred={isProjectStarred(activeProjectId)}
            onToggleStar={toggleProjectStar}
          />
        ) : null}
        <Select
          aria-label="Switch project"
          ref={selectRef}
          size="middle"
          open={dropdownOpen}
          onOpenChange={(open) => {
            setDropdownOpen(open);
            if (!open) {
              setSearchValue("");
            }
          }}
          style={{ minWidth: 260, maxWidth: 400 }}
          placeholder="Switch project…"
          value={activeProjectId}
          showSearch
          optionLabelProp="label"
          filterOption={false}
          searchValue={searchValue}
          onSearch={setSearchValue}
          onClear={() => setSearchValue("")}
          allowClear
          options={groupedOptions}
          popupRender={() => (
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
                      {group.options.map((option) => renderOptionItem(option))}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: "8px 12px", color: "#888" }}>
                    No projects found
                  </div>
                )}
              </div>
              <Divider style={{ margin: "6px 0" }} />
              <div style={{ padding: "4px 8px" }}>
                <Button
                  size="small"
                  onClick={() => actions.set_active_tab("projects")}
                >
                  All projects…
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
      {createPanelMounted.current && (
        <CocalcErrorBoundary
          scope="projects.navigation.create-project"
          resetKeys={[createPanelOpen]}
        >
          <Suspense fallback={null}>
            <NewProjectCreator
              default_value=""
              open={createPanelOpen}
              onClose={() => setCreatePanelOpen(false)}
            />
          </Suspense>
        </CocalcErrorBoundary>
      )}
      {mode === "dropdown" ? (
        renderDropdownNav()
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            height: `${height}px`,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              flex: "0 0 auto",
              height: "100%",
              padding: "0 8px",
            }}
          >
            <Tooltip
              title={
                mode === "tabs" ? "Switch to project list" : "Switch to tabs"
              }
            >
              <Button
                size="small"
                onClick={() => setMode(mode === "tabs" ? "dropdown" : "tabs")}
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
                maxItemWidth={360}
                itemChromeWidth={14}
                overflowWidth={36}
              >
                <div onKeyDownCapture={onTabKeyDown}>
                  <Tabs
                    animated={false}
                    className="cocalc-project-tabs"
                    moreIcon={
                      <Icon
                        style={{ fontSize: "18px" }}
                        name="ellipsis-vertical"
                      />
                    }
                    size="small"
                    tabBarStyle={{ margin: 0 }}
                    activeKey={activeTopTab}
                    addIcon={
                      <AccessibleAddTabIcon label="Create project">
                        <Icon name="plus" />
                      </AccessibleAddTabIcon>
                    }
                    onEdit={onEdit}
                    onChange={(project_id) => {
                      actions.set_active_tab(project_id);
                    }}
                    type={"editable-card"}
                    renderTabBar={renderTabBar0}
                    items={items}
                  />
                </div>
              </SortableTabs>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
