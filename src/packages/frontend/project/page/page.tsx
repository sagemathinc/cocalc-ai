/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DndContext, useDraggable } from "@dnd-kit/core";
import { Alert, Button, Modal, Space, Tooltip } from "antd";
import { useIntl } from "react-intl";
import {
  React,
  redux,
  useActions,
  useEffect,
  useMemo,
  useRedux,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { useAppContext } from "@cocalc/frontend/app/context";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import {
  FrameContext,
  defaultFrameContext,
} from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import StudentPayUpgrade from "@cocalc/frontend/purchases/student-pay";
import track from "@cocalc/frontend/user-tracking";
import { EDITOR_PREFIX, path_to_tab, tab_to_path } from "@cocalc/util/misc";
import { pathMatchesWorkspace } from "@cocalc/conat/workspaces";
import { COLORS } from "@cocalc/util/theme";
import {
  ProjectContext,
  useProjectContext,
  useProjectContextProvider,
} from "../context";
import FileActionModal from "../file-action-modal";
import { ProjectWarningBanner } from "../project-banner";
import { DeletedProjectWarning } from "../warnings/deleted";
import { DiskSpaceWarning } from "../warnings/disk-space";
import { OOMWarning } from "../warnings/oom";
import { RamWarning } from "../warnings/ram";
import { FIX_BORDERS } from "./common";
import { Content } from "./content";
import { AgentDock } from "./agent-dock";
import { isFixedTab } from "./file-tab";
import { FlyoutBody } from "./flyouts/body";
import { FLYOUT_DEFAULT_WIDTH_PX } from "./flyouts/consts";
import { FlyoutHeader } from "./flyouts/header";
import {
  getFlyoutExpanded,
  getFlyoutWidth,
  storeFlyoutState,
} from "./flyouts/state";
import HomePageButton from "./home-page/button";
import { SoftwareEnvUpgrade } from "./software-env-upgrade";
import ProjectTabs, {
  FIXED_TABS_BG_COLOR,
  VerticalFixedTabs,
} from "./activity-bar-tabs";
import { throttle } from "lodash";
import { StartButton } from "@cocalc/frontend/project/start-button";
import { TOGGLE_ACTIVITY_BAR_TOGGLE_BUTTON_SPACE } from "./activity-bar-consts";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  hostLabel,
} from "@cocalc/frontend/projects/host-operational";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import { workspaceStrongThemeChrome } from "../workspaces/strong-theme";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import MoveInProgress from "./move-in-progress";
import {
  PROJECT_PAGE_ATTRIBUTE,
  handleProjectNavigationKeydown,
} from "./keyboard-navigation";

const START_BANNER = false;

const PAGE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  overflow: "hidden",
} as const;

interface Props {
  project_id: string;
  is_active: boolean;
}

export const ProjectPage: React.FC<Props> = (props: Props) => {
  const { project_id, is_active } = props;
  const intl = useIntl();
  const projectPageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainWidthPx, setMainWidthPx] = useState<number>(0);
  const hideActionButtons = useTypedRedux({ project_id }, "hideActionButtons");
  const flyout = useTypedRedux({ project_id }, "flyout");
  const actions = useActions({ project_id });
  const is_deleted = useRedux([
    "projects",
    "project_map",
    project_id,
    "deleted",
  ]);
  const project_color = useRedux([
    "projects",
    "project_map",
    project_id,
    "color",
  ]);
  const projectCtx = useProjectContextProvider({
    project_id,
    is_active,
    mainWidthPx,
  });
  const host_id = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    "host_id",
  ]) as string | undefined;
  const hostInfo = useHostInfo(host_id);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const moveLro = useTypedRedux({ project_id }, "move_lro")?.toJS() as
    | MoveLroState
    | undefined;
  const moveInProgress =
    moveLro != null &&
    (!moveLro.summary ||
      moveLro.summary.status === "queued" ||
      moveLro.summary.status === "running");
  const hostUnavailable = !!host_id && hostOperational.state === "unavailable";
  const workspaceBlocked = hostUnavailable || moveInProgress;
  const hostUnavailableReason =
    hostOperational.reason ?? "Assigned host is unavailable.";
  const assignedHostLabel = hostLabel(hostInfo, host_id);
  const fullscreen = useTypedRedux("page", "fullscreen");
  const active_top_tab = useTypedRedux("page", "active_top_tab");
  const modal = useTypedRedux({ project_id }, "modal");
  const open_files = useTypedRedux({ project_id }, "open_files");
  const open_files_order = useTypedRedux({ project_id }, "open_files_order");
  const active_project_tab = useTypedRedux(
    { project_id },
    "active_project_tab",
  );
  const current_path_abs = useTypedRedux({ project_id }, "current_path_abs");
  const [homePageButtonWidth, setHomePageButtonWidth] =
    React.useState<number>(80);
  const [checkingHost, setCheckingHost] = useState<boolean>(false);

  const [flyoutWidth, setFlyoutWidth] = useState<number>(
    getFlyoutWidth(project_id),
  );
  const [oldFlyoutWidth, setOldFlyoutWidth] = useState(flyoutWidth);
  const { pageWidthPx } = useAppContext();
  const workspaceChrome = workspaceStrongThemeChrome(
    projectCtx.workspaces.current,
  );

  const narrowerPX = useMemo(() => {
    return hideActionButtons ? homePageButtonWidth : 0;
  }, [hideActionButtons, homePageButtonWidth]);
  const [workspaceStartupGuard, setWorkspaceStartupGuard] =
    useState<boolean>(true);

  const initialWorkspaceRender = useMemo(() => {
    const orderedPaths: string[] =
      open_files_order?.toJS?.() ?? open_files_order ?? [];
    if (!workspaceStartupGuard) {
      return {
        pending: false,
        renderPaths: orderedPaths,
        displayActiveTab: active_project_tab,
      };
    }
    const { workspaces } = projectCtx;
    if (workspaces.selection.kind !== "workspace") {
      return {
        pending: false,
        renderPaths: orderedPaths,
        displayActiveTab: active_project_tab,
      };
    }
    const current = workspaces.current;
    if (!current) {
      return {
        pending: false,
        renderPaths: orderedPaths,
        displayActiveTab: active_project_tab,
      };
    }
    const visiblePaths = workspaces.filterPaths(orderedPaths);
    const fallbackPath =
      current.last_active_path != null &&
      visiblePaths.includes(current.last_active_path)
        ? current.last_active_path
        : visiblePaths[0];
    const activePath = tab_to_path(active_project_tab ?? "");
    const activePathIsVisible =
      !!activePath && visiblePaths.includes(activePath);
    const filesInWorkspace =
      active_project_tab === "files" &&
      !!current_path_abs &&
      pathMatchesWorkspace(current, current_path_abs);
    const pending =
      (active_project_tab?.startsWith(EDITOR_PREFIX)
        ? !activePathIsVisible
        : active_project_tab !== "files" || !filesInWorkspace) &&
      (fallbackPath != null || workspaces.loading);
    return {
      pending,
      renderPaths:
        pending && fallbackPath != null ? [fallbackPath] : orderedPaths,
      displayActiveTab:
        pending && fallbackPath != null
          ? path_to_tab(fallbackPath)
          : active_project_tab,
    };
  }, [
    active_project_tab,
    current_path_abs,
    open_files_order,
    projectCtx.workspaces,
    workspaceStartupGuard,
  ]);

  useEffect(() => {
    if (!workspaceStartupGuard) return;
    const { workspaces } = projectCtx;
    if (workspaces.selection.kind !== "workspace") {
      setWorkspaceStartupGuard(false);
      return;
    }
    if (workspaces.loading && workspaces.current == null) {
      return;
    }
    if (!initialWorkspaceRender.pending) {
      setWorkspaceStartupGuard(false);
    }
  }, [
    initialWorkspaceRender.pending,
    projectCtx.workspaces.current,
    projectCtx.workspaces.loading,
    projectCtx.workspaces.selection,
    workspaceStartupGuard,
  ]);

  useEffect(() => {
    const name = getFlyoutExpanded(project_id);
    if (isFixedTab(name)) {
      // if there is one to show, restore its width
      setFlyoutWidth(getFlyoutWidth(project_id));
      actions?.setFlyoutExpanded(name, true, false);
    }
  }, [project_id]);

  useEffect(() => {
    if (flyoutWidth > pageWidthPx * 0.9) {
      setFlyoutWidth(Math.max(FLYOUT_DEFAULT_WIDTH_PX / 2, pageWidthPx * 0.9));
    }
  }, [pageWidthPx]);

  useEffect(() => {
    if (!is_active) return;

    function handleKeydown(event: KeyboardEvent) {
      handleProjectNavigationKeydown(event, project_id, {
        activeProjectTab: active_project_tab,
        projectActions: actions as any,
        projectRoot: projectPageRef.current,
      });
    }

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [active_project_tab, actions, is_active, open_files, project_id]);

  // observe debounced width changes of mainRef div and set it via setMainWidthPx
  useEffect(() => {
    const main = mainRef.current;
    if (main == null) return;
    const resizeObserver = new ResizeObserver(
      throttle(
        (entries) => {
          if (entries.length > 0) {
            setMainWidthPx(entries[0].contentRect.width);
          }
        },
        100,
        { leading: false, trailing: true },
      ),
    );
    resizeObserver.observe(main);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  function setWidth(newWidth: number, reset = false): void {
    if (flyout == null) return;
    setFlyoutWidth(newWidth);
    storeFlyoutState(project_id, flyout, { width: reset ? null : newWidth });
  }

  async function resetFlyoutWidth() {
    // brief delay to ignore what dragging does
    await new Promise((resolve) => setTimeout(resolve, 10));
    setWidth(FLYOUT_DEFAULT_WIDTH_PX + narrowerPX, true);
  }

  const flyoutLimit = useMemo(() => {
    return {
      left: FLYOUT_DEFAULT_WIDTH_PX / 2,
      right: IS_MOBILE ? pageWidthPx * 0.9 : pageWidthPx / 2,
    };
  }, [pageWidthPx]);

  function updateDrag(e) {
    const newWidth = Math.max(
      flyoutLimit.left,
      Math.min(oldFlyoutWidth + e.delta.x, flyoutLimit.right),
    );
    setWidth(newWidth);
  }

  function renderEditorContent() {
    const v: React.JSX.Element[] = [];

    initialWorkspaceRender.renderPaths.map((path) => {
      if (!path) {
        return;
      }
      const syncPathValue = open_files?.getIn([path, "sync_path"]);
      const syncPath =
        typeof syncPathValue === "string" && syncPathValue.length > 0
          ? syncPathValue
          : path;
      const tab_name = path_to_tab(path);
      return v.push(
        <FrameContext.Provider
          key={tab_name}
          value={{
            ...defaultFrameContext,
            project_id,
            path,
            actions: redux.getEditorActions(project_id, syncPath) as any,
            isFocused: initialWorkspaceRender.displayActiveTab === tab_name,
            isVisible: initialWorkspaceRender.displayActiveTab === tab_name,
            redux,
          }}
        >
          <Content
            is_visible={
              active_top_tab == project_id &&
              initialWorkspaceRender.displayActiveTab === tab_name
            }
            tab_name={tab_name}
          />
        </FrameContext.Provider>,
      );
    });
    return v;
  }

  // fixed tab -- not an editor
  function render_project_content() {
    if (!is_active) {
      // see https://github.com/sagemathinc/cocalc/issues/3799
      // Some of the fixed project tabs (none editors) are hooked
      // into redux and moronic about rendering everything on every
      // tiny change... Until that is fixed, it is critical to NOT
      // render these pages at all, unless the tab is active
      // and they are visible.
      return;
    }
    if (
      !initialWorkspaceRender.pending &&
      initialWorkspaceRender.displayActiveTab &&
      initialWorkspaceRender.displayActiveTab.slice(0, 7) !== EDITOR_PREFIX
    ) {
      return (
        <Content
          key={initialWorkspaceRender.displayActiveTab}
          is_visible={true}
          tab_name={initialWorkspaceRender.displayActiveTab}
        />
      );
    }
  }

  function render_project_modal() {
    if (!is_active || !modal) return;
    return (
      <Modal
        title={modal?.get("title")}
        open={is_active && modal != null}
        onOk={() => {
          actions?.clear_modal();
          modal?.get("onOk")?.();
        }}
        onCancel={() => {
          actions?.clear_modal();
          modal?.get("onCancel")?.();
        }}
      >
        {modal?.get("content")}
      </Modal>
    );
  }

  function renderFlyout() {
    if (!flyout) return;
    if (fullscreen && fullscreen !== "project") return;

    return (
      <div style={{ display: "flex", flexDirection: "row" }}>
        <FlyoutBody flyout={flyout} flyoutWidth={flyoutWidth} />
        <DndContext
          onDragStart={() => setOldFlyoutWidth(flyoutWidth)}
          onDragEnd={(e) => updateDrag(e)}
        >
          <FlyoutDragbar
            resetFlyoutWidth={resetFlyoutWidth}
            flyoutLimit={flyoutLimit}
            oldFlyoutWidth={oldFlyoutWidth}
          />
        </DndContext>
      </div>
    );
  }

  function renderFlyoutHeader() {
    if (!flyout) return;
    return (
      <FlyoutHeader
        flyoutWidth={flyoutWidth}
        flyout={flyout}
        narrowerPX={narrowerPX}
      />
    );
  }

  function renderTopRow() {
    if (fullscreen && fullscreen !== "project") return;

    if (workspaceBlocked) {
      return (
        <div style={{ display: "flex", height: "36px" }}>
          <HomePageButton
            project_id={project_id}
            active={active_project_tab == "home"}
            width={homePageButtonWidth}
          />
          <div style={{ flex: 1 }} />
        </div>
      );
    }

    // CSS note: the paddingTop is here to not make the tabs touch the top row (looks funny)
    // this was part of the container-content div, which makes little sense for e.g. the banner bars
    return (
      <div style={{ display: "flex", height: "36px" }}>
        <HomePageButton
          project_id={project_id}
          active={active_project_tab == "home"}
          width={homePageButtonWidth}
        />
        {renderFlyoutHeader()}
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          <StartButton minimal style={{ margin: "2px 4px 0px 4px" }} />
          <ProjectTabs project_id={project_id} />
        </div>
      </div>
    );
  }

  function renderActivityBarButtons() {
    if (fullscreen && fullscreen !== "project") return;

    if (hideActionButtons) {
      return (
        <Tooltip
          title={intl.formatMessage({
            id: "project.page.activity-bar.show.tooltip",
            defaultMessage: "Show the activity bar",
            description: "This shows the vertical activity bar in the UI",
          })}
          placement="rightTop"
        >
          <Button
            size="small"
            type="text"
            style={{
              position: "fixed",
              bottom: "0px",
              marginBottom: TOGGLE_ACTIVITY_BAR_TOGGLE_BUTTON_SPACE,
              left: "0px",
              zIndex: 1000,
              outline: `1px solid ${
                workspaceChrome?.activityBarBorder ?? COLORS.GRAY_L
              }`,
              borderRadius: "0 3px 0 0 ",
              background: workspaceChrome?.activityBarBackground,
              backgroundColor:
                workspaceChrome == null ? COLORS.GRAY_LLL : undefined,
              boxShadow: workspaceChrome
                ? `inset -2px 0 0 ${workspaceChrome.activityBarBorder}`
                : undefined,
            }}
            onClick={() => {
              track("action-bar", { action: "show" });
              actions?.toggleActionButtons();
            }}
          >
            <Icon name="vertical-left-outlined" />
          </Button>
        </Tooltip>
      );
    } else {
      return (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            background:
              workspaceChrome?.activityBarBackground ?? FIXED_TABS_BG_COLOR,
            borderRadius: "0",
            position: "relative",
            borderTop: FIX_BORDERS.borderTop,
            borderRight: flyout == null ? FIX_BORDERS.borderRight : undefined,
          }}
        >
          {workspaceChrome != null ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                zIndex: 1,
                boxSizing: "border-box",
                borderRight: `2px solid ${workspaceChrome.activityBarBorder}`,
              }}
            />
          ) : null}
          <VerticalFixedTabs setHomePageButtonWidth={setHomePageButtonWidth} />
        </div>
      );
    }
  }

  function renderMainContent() {
    if (moveInProgress && moveLro) {
      return <MoveInProgress project_id={project_id} moveLro={moveLro} />;
    }

    if (hostUnavailable) {
      return (
        <div
          ref={mainRef}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflowX: "auto",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div style={{ maxWidth: "900px", width: "100%", padding: "0 24px" }}>
            <Alert
              showIcon
              type="warning"
              title="Project host is not available"
              description={`This project is assigned to ${assignedHostLabel}, which is unavailable (${hostUnavailableReason}).

You can wait for this host to become available again, or move this project to another host.`}
            />
            <div style={{ marginTop: "12px" }}>
              <Space wrap>
                <Button
                  size="large"
                  loading={checkingHost}
                  onClick={async () => {
                    if (!host_id) return;
                    try {
                      setCheckingHost(true);
                      await redux
                        .getActions("projects")
                        ?.ensure_host_info(host_id, true);
                    } catch (err) {
                      console.warn("failed to refresh host status", err);
                    } finally {
                      setCheckingHost(false);
                    }
                  }}
                >
                  <Icon name="refresh" /> Check Host Status
                </Button>
                <MoveProject
                  project_id={project_id}
                  size="large"
                  label="Move Project"
                  showHostName={false}
                />
              </Space>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        ref={mainRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflowX: "auto",
        }}
      >
        {START_BANNER && <StartButton />}
        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {renderEditorContent()}
          {render_project_content()}
          <AgentDock project_id={project_id} is_active={is_active} />
        </div>
        {render_project_modal()}
        <FileActionModal />
      </div>
    );
  }

  if (open_files_order == null) {
    return <Loading />;
  }

  return (
    <ProjectContext.Provider value={projectCtx}>
      <div
        ref={projectPageRef}
        className="container-content"
        {...{ [PROJECT_PAGE_ATTRIBUTE]: project_id }}
        style={{
          ...PAGE_STYLE,
          position: "relative",
          borderLeft: project_color
            ? `2.5px solid ${project_color}`
            : undefined,
        }}
      >
        {workspaceChrome != null ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 1,
              boxSizing: "border-box",
              borderTop: workspaceChrome.frameTopBorder,
              borderRight: workspaceChrome.frameRightBorder,
              borderBottom: workspaceChrome.frameBottomBorder,
            }}
          />
        ) : null}
        <StudentPayUpgrade project_id={project_id} />
        <DiskSpaceWarning project_id={project_id} />
        <RamWarning project_id={project_id} />
        <OOMWarning project_id={project_id} />
        <SoftwareEnvUpgrade project_id={project_id} />
        <ProjectWarningBanner />
        {renderTopRow()}
        {is_deleted && <DeletedProjectWarning />}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {!workspaceBlocked && renderActivityBarButtons()}
          {!workspaceBlocked && renderFlyout()}
          {renderMainContent()}
        </div>
      </div>
    </ProjectContext.Provider>
  );
};

function FlyoutDragbar({
  resetFlyoutWidth,
  flyoutLimit,
  oldFlyoutWidth,
}: {
  resetFlyoutWidth: () => void;
  flyoutLimit: { left: number; right: number };
  oldFlyoutWidth: number;
}) {
  const { project_id } = useProjectContext();

  const { attributes, listeners, setNodeRef, transform, active } = useDraggable(
    {
      id: `flyout-drag-${project_id}`,
    },
  );

  // limit left-right dx movement
  const dx = useMemo(() => {
    if (!transform || !oldFlyoutWidth) return 0;
    const dx = transform.x;
    const posX = oldFlyoutWidth + dx;
    const { left, right } = flyoutLimit;
    if (posX < left) return -(oldFlyoutWidth - left);
    if (posX > right) return right - oldFlyoutWidth;
    return dx;
  }, [transform, oldFlyoutWidth, flyoutLimit]);

  return (
    <div
      ref={setNodeRef}
      className="cc-project-flyout-dragbar"
      style={{
        transform: transform ? `translate3d(${dx}px, 0, 0)` : undefined,
        flex: "1 0 ",
        width: "5px",
        height: "100%",
        cursor: "col-resize",
        ...(active ? { zIndex: 1000, backgroundColor: COLORS.GRAY } : {}),
      }}
      {...listeners}
      {...attributes}
      onDoubleClick={resetFlyoutWidth}
    />
  );
}
