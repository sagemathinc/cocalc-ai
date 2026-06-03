/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DndContext, useDraggable } from "@dnd-kit/core";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  React,
  redux,
  useActions,
  useEffect,
  useMemo,
  useProjectMapField,
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
import { DiskSpaceWarning } from "../warnings/disk-space";
import { OOMWarning } from "../warnings/oom";
import { RamWarning } from "../warnings/ram";
import { FIX_BORDERS } from "./common";
import { Content } from "./content";
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
import ProjectTabs, {
  FIXED_TABS_BG_COLOR,
  HiddenActivityBarLauncher,
  VerticalFixedTabs,
} from "./activity-bar-tabs";
import { useActivityBarPreferences } from "./activity-bar-storage";
import { throttle } from "lodash";
import { StartButton } from "@cocalc/frontend/project/start-button";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  getProjectLifecycleView,
  hostLabel,
} from "@cocalc/frontend/projects/host-operational";
import { projectThemeColor } from "@cocalc/frontend/projects/theme";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import ProjectControlStatus from "@cocalc/frontend/project/settings/project-control-status";
import { workspaceStrongThemeChrome } from "../workspaces/strong-theme";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import MoveInProgress from "./move-in-progress";
import StartInProgress from "./start-in-progress";
import {
  PROJECT_PAGE_ATTRIBUTE,
  handleProjectNavigationKeydown,
} from "./keyboard-navigation";
import { shouldRenderMoveStatus } from "./move-status";
import { getRecoverableActiveEditorPath } from "./active-editor-recovery";
import {
  hasProjectRoleForAccessLandingBypass,
  projectAccessSignInHrefForCurrentLocation,
  shouldFetchProjectAccessLandingInfo,
} from "./access-landing-auth";
import { HardDeleteProjectModal } from "@cocalc/frontend/projects/hard-delete-project-modal";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import type { ProjectAccessLandingInfo } from "@cocalc/conat/hub/api/projects";
import { lite } from "@cocalc/frontend/lite";

const START_BANNER = false;

const PAGE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  overflow: "hidden",
} as const;
const HIDDEN_RAIL_TOP_LEFT_WIDTH_PX = 84;
const HIDDEN_RAIL_HOME_BUTTON_WIDTH_PX = 44;
const { Paragraph, Text, Title } = Typography;

interface Props {
  project_id: string;
  is_active: boolean;
}

export const ProjectPage: React.FC<Props> = (props: Props) => {
  const accountIsReady = !!useTypedRedux("account", "is_ready");
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const groups = useTypedRedux("account", "groups") as string[] | undefined;
  const project = useRedux(["projects", "project_map", props.project_id]);
  if (!accountIsReady) {
    return <Loading />;
  }
  if (!isLoggedIn) {
    return <ProjectAccessSignInRequired />;
  }
  if (
    !hasProjectRoleForAccessLandingBypass({
      accountId,
      project,
      isAdmin: !!groups?.includes("admin"),
      liteMode: lite,
    })
  ) {
    return (
      <ProjectAccessLandingGate
        project_id={props.project_id}
        is_active={props.is_active}
      />
    );
  }
  return <SignedInProjectPage {...props} />;
};

const SignedInProjectPage: React.FC<Props> = (props) => {
  const { project_id, is_active } = props;
  const projectPageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainWidthPx, setMainWidthPx] = useState<number>(0);
  const { collapsed: hideActionButtons } = useActivityBarPreferences();
  const flyout = useTypedRedux({ project_id }, "flyout");
  const actions = useActions({ project_id });
  const project = useRedux(["projects", "project_map", project_id]);
  const project_color = projectThemeColor(project);
  const hardDeleteState = `${project?.getIn(["state", "state"]) ?? ""}`;
  const hardDeleteBlocked =
    hardDeleteState === "deleting" || hardDeleteState === "delete_failed";
  const hardDeleteOpId = `${project?.getIn(["state", "hard_delete_op_id"]) ?? ""}`;
  const hardDeleteError = `${project?.getIn(["state", "hard_delete_error"]) ?? ""}`;
  const projectCtx = useProjectContextProvider({
    project_id,
    is_active,
    mainWidthPx,
  });
  const isViewer = projectCtx.projectAccess.role === "viewer";
  const host_id = useProjectMapField<string>(project_id, "host_id");
  const hostInfo = useHostInfo(host_id);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const moveLro = useTypedRedux({ project_id }, "move_lro")?.toJS() as
    | MoveLroState
    | undefined;
  const moveReopenRequired = !!useTypedRedux(
    { project_id },
    "move_reopen_required",
  );
  const moveStatusVisible = shouldRenderMoveStatus(moveLro, moveReopenRequired);
  const hostUnavailable = !!host_id && hostOperational.state === "unavailable";
  const lifecycle = useMemo(
    () =>
      getProjectLifecycleView({
        projectState: project?.getIn(["state", "state"]),
        hostId: host_id,
        hostInfo,
        lastBackup: project?.get("last_backup"),
      }),
    [hostInfo, host_id, project],
  );
  const archivedLike = lifecycle.isArchivedLike;
  const workspaceBlocked = moveStatusVisible;
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
    return hideActionButtons ? HIDDEN_RAIL_TOP_LEFT_WIDTH_PX : 0;
  }, [hideActionButtons]);
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
    if (!is_active || !actions) {
      return;
    }
    if (!archivedLike) {
      return;
    }
    if ((open_files_order?.size ?? 0) > 0) {
      actions.close_all_files?.();
    }
    if (
      (active_project_tab ?? "").startsWith(EDITOR_PREFIX) ||
      active_project_tab === "files"
    ) {
      actions.set_active_tab("home", { change_history: false });
    }
  }, [archivedLike, actions, active_project_tab, is_active, open_files_order]);

  useEffect(() => {
    if (!is_active || !actions || !hardDeleteBlocked) {
      return;
    }
    actions.close_all_files?.();
    actions.set_active_tab?.("home", { change_history: false });
  }, [actions, hardDeleteBlocked, is_active]);

  const recoverActiveEditorComponent = React.useCallback(() => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const path = getRecoverableActiveEditorPath({
      isActive: is_active,
      activeTopTab: active_top_tab,
      projectId: project_id,
      activeProjectTab: active_project_tab,
      openFiles: open_files,
    });
    if (path == null) return;
    actions?.ensure_open_file_component?.(path);
  }, [
    actions,
    active_project_tab,
    active_top_tab,
    is_active,
    open_files,
    project_id,
  ]);

  useEffect(() => {
    recoverActiveEditorComponent();
  }, [recoverActiveEditorComponent]);

  useEffect(() => {
    const recoverIfVisible = () => {
      recoverActiveEditorComponent();
    };
    document.addEventListener("visibilitychange", recoverIfVisible);
    window.addEventListener("focus", recoverIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", recoverIfVisible);
      window.removeEventListener("focus", recoverIfVisible);
    };
  }, [recoverActiveEditorComponent]);

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
    if (archivedLike || hardDeleteBlocked) {
      return [];
    }
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
    if (hardDeleteBlocked) {
      return;
    }
    if (!is_active) {
      // see https://github.com/sagemathinc/cocalc/issues/3799
      // Some of the fixed project tabs (none editors) are hooked
      // into redux and moronic about rendering everything on every
      // tiny change... Until that is fixed, it is critical to NOT
      // render these pages at all, unless the tab is active
      // and they are visible.
      return;
    }
    let displayTab = initialWorkspaceRender.displayActiveTab;
    if (lifecycle.shouldForceHomeTab && displayTab === "files") {
      displayTab = "home";
    }
    if (
      !initialWorkspaceRender.pending &&
      displayTab &&
      displayTab.slice(0, 7) !== EDITOR_PREFIX
    ) {
      return (
        <Content key={displayTab} is_visible={true} tab_name={displayTab} />
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

    if (workspaceBlocked || hardDeleteBlocked) {
      return (
        <div style={{ display: "flex", height: "36px" }}>
          {hideActionButtons ? <HiddenActivityBarLauncher /> : null}
          <HomePageButton
            project_id={project_id}
            active={active_project_tab == "home"}
            width={
              hideActionButtons
                ? HIDDEN_RAIL_HOME_BUTTON_WIDTH_PX
                : homePageButtonWidth
            }
          />
          <div style={{ flex: 1 }} />
        </div>
      );
    }

    // CSS note: the paddingTop is here to not make the tabs touch the top row (looks funny)
    // this was part of the container-content div, which makes little sense for e.g. the banner bars
    return (
      <div style={{ display: "flex", height: "36px" }}>
        {hideActionButtons ? <HiddenActivityBarLauncher /> : null}
        <HomePageButton
          project_id={project_id}
          active={active_project_tab == "home"}
          width={
            hideActionButtons
              ? HIDDEN_RAIL_HOME_BUTTON_WIDTH_PX
              : homePageButtonWidth
          }
        />
        {renderFlyoutHeader()}
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          {isViewer ? (
            <ViewerReadOnlyTag project_id={project_id} />
          ) : (
            projectCtx.projectAccess.capabilities.useProjectRuntime && (
              <StartButton minimal style={{ margin: "2px 4px 0px 4px" }} />
            )
          )}
          <ProjectTabs project_id={project_id} />
        </div>
      </div>
    );
  }

  function renderHostUnavailableBanner() {
    if (!hostUnavailable || hardDeleteBlocked) return;
    return (
      <Alert
        showIcon
        type="warning"
        banner
        message="Project host is not available"
        description={
          <Space wrap>
            <span>
              This project is assigned to {assignedHostLabel}, which is
              unavailable ({hostUnavailableReason}). File access may fail until
              the host comes back online, but project settings and cached
              metadata are still available.
            </span>
            <Button
              size="small"
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
              size="small"
              label="Move Project"
              showHostName={false}
            />
          </Space>
        }
      />
    );
  }

  function renderActivityBarButtons() {
    if (fullscreen && fullscreen !== "project") return;

    if (hideActionButtons) {
      return null;
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
    if (hardDeleteBlocked) {
      return (
        <HardDeleteProjectStatus
          project_id={project_id}
          title={project?.get("title")}
          state={hardDeleteState}
          op_id={hardDeleteOpId || undefined}
          error={hardDeleteError || undefined}
        />
      );
    }

    if (moveStatusVisible && moveLro) {
      return <MoveInProgress project_id={project_id} moveLro={moveLro} />;
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
        <ProjectControlStatus banner />
        <StartInProgress project_id={project_id} />
        {START_BANNER &&
          projectCtx.projectAccess.capabilities.useProjectRuntime && (
            <StartButton />
          )}
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
        </div>
        {render_project_modal()}
        <FileActionModal />
      </div>
    );
  }

  if (open_files_order == null && !hardDeleteBlocked) {
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
        {!hardDeleteBlocked && !isViewer && (
          <DiskSpaceWarning project_id={project_id} />
        )}
        {!hardDeleteBlocked && !isViewer && (
          <RamWarning project_id={project_id} />
        )}
        {!hardDeleteBlocked && !isViewer && (
          <OOMWarning project_id={project_id} />
        )}
        {!hardDeleteBlocked && !isViewer && <ProjectWarningBanner />}
        {renderHostUnavailableBanner()}
        {renderTopRow()}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {!workspaceBlocked &&
            !hardDeleteBlocked &&
            renderActivityBarButtons()}
          {!workspaceBlocked && !hardDeleteBlocked && renderFlyout()}
          {renderMainContent()}
        </div>
      </div>
    </ProjectContext.Provider>
  );
};

function ViewerReadOnlyTag({ project_id }: { project_id: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);

  async function requestCollaboratorAccess() {
    setBusy(true);
    setError(null);
    try {
      await webapp_client.project_collaborators.request_access({
        project_id,
        requested_role: "collaborator",
        source: "viewer-read-only",
      });
      setStatus("requested");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Tag
        color={COLORS.BG_WARNING}
        onClick={() => setOpen(true)}
        style={{
          alignSelf: "center",
          color: "black",
          cursor: "pointer",
          margin: "2px 6px 0px 4px",
          whiteSpace: "nowrap",
        }}
      >
        Read only
      </Tag>
      <Modal
        title="Read-only project access"
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="close" onClick={() => setOpen(false)}>
            Close
          </Button>,
          <Button
            key="request"
            type="primary"
            loading={busy}
            disabled={status === "requested"}
            onClick={requestCollaboratorAccess}
          >
            {status === "requested"
              ? "Collaborator access requested"
              : "Request collaborator access"}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Paragraph>
            You can browse and open allowed project files, but cannot edit
            files, start the runtime, use terminals, run agents, or change
            project settings.
          </Paragraph>
          {status === "requested" && (
            <Alert
              showIcon
              type="success"
              message="Request sent"
              description="A project owner or authorized collaborator can approve collaborator access."
            />
          )}
          {error && (
            <Alert
              showIcon
              type="error"
              message="Unable to request collaborator access"
              description={error}
            />
          )}
        </Space>
      </Modal>
    </>
  );
}

function ProjectAccessSignInRequired() {
  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: COLORS.GRAY_LLL,
      }}
    >
      <Card style={{ maxWidth: 520, width: "100%" }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Title level={3} style={{ margin: 0 }}>
            Sign in to request project access
          </Title>
          <Paragraph style={{ margin: 0 }}>
            CoCalc does not show project details until you sign in. After
            signing in, you can request viewer or collaborator access if the
            project is available to you.
          </Paragraph>
          <Button
            type="primary"
            href={projectAccessSignInHrefForCurrentLocation()}
          >
            Sign in
          </Button>
        </Space>
      </Card>
    </div>
  );
}

function ProjectAccessLandingGate({ project_id, is_active }: Props) {
  const [accessLanding, setAccessLanding] =
    useState<ProjectAccessLandingInfo | null>(null);
  const [accessLandingError, setAccessLandingError] = useState<string | null>(
    null,
  );
  const [accessLandingLoading, setAccessLandingLoading] =
    useState<boolean>(false);

  useEffect(() => {
    if (
      !shouldFetchProjectAccessLandingInfo({
        isActive: is_active,
        accountIsReady: true,
        isLoggedIn: true,
        hasProject: false,
        liteMode: lite,
      })
    ) {
      return;
    }
    let canceled = false;
    setAccessLandingLoading(true);
    setAccessLandingError(null);
    webapp_client.project_collaborators
      .get_access_landing_info({ project_id })
      .then((info) => {
        if (canceled) return;
        setAccessLanding(info);
      })
      .catch((err) => {
        if (canceled) return;
        setAccessLandingError(`${err}`);
      })
      .finally(() => {
        if (canceled) return;
        setAccessLandingLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [is_active, project_id]);

  if (
    accessLanding != null &&
    (accessLanding.relationship === "none" ||
      accessLanding.pending_invite != null ||
      accessLanding.pending_request != null ||
      accessLanding.blocked)
  ) {
    return (
      <ProjectAccessLandingPage
        info={accessLanding}
        loading={accessLandingLoading}
        error={accessLandingError}
        onChange={setAccessLanding}
      />
    );
  }
  if (accessLandingError != null) {
    return (
      <ProjectAccessLandingError
        project_id={project_id}
        error={accessLandingError}
      />
    );
  }
  return <Loading />;
}

function ProjectAccessLandingPage({
  info,
  loading,
  error,
  onChange,
}: {
  info: ProjectAccessLandingInfo;
  loading: boolean;
  error: string | null;
  onChange: (info: ProjectAccessLandingInfo) => void;
}) {
  const [requestedRole, setRequestedRole] = useState<"viewer" | "collaborator">(
    info.relationship === "viewer" ? "collaborator" : "viewer",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const projectTitle = info.title?.trim() || "Untitled project";
  const owner = info.owner;
  const canChooseViewer = info.relationship !== "viewer";

  async function refreshProjectAccess() {
    await (
      redux.getActions("projects") as any
    )?.ensureRealtimeFeedForCurrentAccount?.();
    await redux.getActions("projects").open_project({
      project_id: info.project_id,
      target: "files",
      switch_to: true,
      restore_session: false,
    });
  }

  async function acceptInvite() {
    if (!info.pending_invite) return;
    setBusy(true);
    setActionError(null);
    try {
      await webapp_client.project_collaborators.respond_invite({
        invite_id: info.pending_invite.invite_id,
        project_id: info.project_id,
        action: "accept",
      });
      await refreshProjectAccess();
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function declineInvite() {
    if (!info.pending_invite) return;
    setBusy(true);
    setActionError(null);
    try {
      await webapp_client.project_collaborators.respond_invite({
        invite_id: info.pending_invite.invite_id,
        project_id: info.project_id,
        action: "decline",
      });
      const next =
        await webapp_client.project_collaborators.get_access_landing_info({
          project_id: info.project_id,
        });
      onChange(next);
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function requestAccess() {
    setBusy(true);
    setActionError(null);
    try {
      const request = await webapp_client.project_collaborators.request_access({
        project_id: info.project_id,
        requested_role: requestedRole,
        message,
        source:
          info.relationship === "viewer" ? "viewer-read-only" : "project-url",
      });
      onChange({
        ...info,
        pending_request: {
          request_id: request.request_id,
          requested_role: request.requested_role,
          status: "pending",
        },
      });
      setMessage("");
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: COLORS.GRAY_LLL,
      }}
    >
      <Card style={{ width: "100%", maxWidth: 680 }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
              Project access
            </Title>
            <Text type="secondary">
              You are signed in, but this project is not currently available as
              a normal collaborator project.
            </Text>
          </div>
          <div
            style={{
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: 10,
              padding: 14,
              background: "white",
            }}
          >
            <Title level={4} style={{ marginTop: 0 }}>
              {projectTitle}
            </Title>
            {owner != null && (
              <Space>
                <Avatar
                  account_id={owner.account_id}
                  first_name={owner.first_name ?? undefined}
                  last_name={owner.last_name ?? undefined}
                  size={32}
                />
                <span>
                  Owner:{" "}
                  <Text strong>
                    {owner.name ||
                      `${owner.first_name ?? ""} ${owner.last_name ?? ""}`.trim() ||
                      "Unknown"}
                  </Text>
                </span>
              </Space>
            )}
          </div>
          {info.pending_invite != null ? (
            <Alert
              showIcon
              type="success"
              message={`You were invited as a ${info.pending_invite.invite_role}.`}
              description={
                <Space wrap style={{ marginTop: 8 }}>
                  <Button type="primary" loading={busy} onClick={acceptInvite}>
                    Accept invite
                  </Button>
                  <Button disabled={busy} onClick={declineInvite}>
                    Decline
                  </Button>
                </Space>
              }
            />
          ) : info.pending_request != null ? (
            <Alert
              showIcon
              type="info"
              message="Access request pending"
              description={`You requested ${info.pending_request.requested_role} access. A project owner or authorized collaborator can approve it.`}
            />
          ) : info.blocked ? (
            <Alert
              showIcon
              type="warning"
              message="Access requests are not available"
              description="This project is not accepting access requests from your account."
            />
          ) : (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Paragraph style={{ marginBottom: 0 }}>
                Request access from the project owner or an authorized
                collaborator.
              </Paragraph>
              <Radio.Group
                value={requestedRole}
                onChange={(e) => setRequestedRole(e.target.value)}
              >
                {canChooseViewer && <Radio value="viewer">Viewer</Radio>}
                <Radio value="collaborator">Collaborator</Radio>
              </Radio.Group>
              <Input.TextArea
                rows={3}
                maxLength={512}
                showCount
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional short message"
              />
              <Button
                type="primary"
                loading={busy || loading}
                onClick={requestAccess}
              >
                Request access
              </Button>
            </Space>
          )}
          {(error || actionError) && (
            <Alert
              showIcon
              type="error"
              message="Unable to update project access"
              description={actionError ?? error}
            />
          )}
          <Space>
            <Button
              onClick={() => {
                redux.getActions("page").close_project_tab(info.project_id);
                redux.getActions("page").set_active_tab("projects");
              }}
            >
              Back to projects
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  );
}

function ProjectAccessLandingError({
  project_id,
  error,
}: {
  project_id: string;
  error: string;
}) {
  return (
    <div style={{ padding: 24 }}>
      <Alert
        showIcon
        type="error"
        message="Unable to open project"
        description={error}
        action={
          <Button
            onClick={() => {
              redux.getActions("page").close_project_tab(project_id);
              redux.getActions("page").set_active_tab("projects");
            }}
          >
            Back to projects
          </Button>
        }
      />
    </div>
  );
}

function HardDeleteProjectStatus({
  project_id,
  title,
  state,
  op_id,
  error,
}: {
  project_id: string;
  title?: string;
  state: string;
  op_id?: string;
  error?: string;
}) {
  const failed = state === "delete_failed";
  const [retryOpen, setRetryOpen] = useState(false);
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: failed ? COLORS.ANTD_BG_RED_L : COLORS.YELL_LLL,
      }}
    >
      <div
        style={{
          maxWidth: 720,
          width: "100%",
          background: "white",
          border: `1px solid ${failed ? COLORS.ANTD_BG_RED_M : COLORS.YELL_LL}`,
          borderRadius: 12,
          padding: 24,
          boxShadow: "0 12px 32px rgba(15, 23, 42, 0.14)",
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space align="start" size="middle">
            <span
              style={{
                alignItems: "center",
                background: failed ? COLORS.ANTD_BG_RED_L : COLORS.YELL_LLL,
                border: `1px solid ${
                  failed ? COLORS.ANTD_BG_RED_M : COLORS.YELL_LL
                }`,
                borderRadius: 12,
                color: failed ? COLORS.FG_RED : COLORS.YELL_D,
                display: "inline-flex",
                fontSize: 22,
                height: 44,
                justifyContent: "center",
                width: 44,
              }}
            >
              <Icon name={failed ? "warning" : "trash"} />
            </span>
            <div>
              <h2 style={{ margin: "0 0 4px" }}>
                {failed
                  ? "Project deletion failed"
                  : "Project deletion in progress"}
              </h2>
              <div style={{ color: COLORS.GRAY_M }}>
                {failed
                  ? "Permanent deletion could not finish. Normal project actions are disabled until deletion is retried or support resolves the failure."
                  : "This project is being permanently deleted. It cannot be opened, started, edited, archived, or moved."}
              </div>
            </div>
          </Space>
          <Alert
            showIcon
            type={failed ? "error" : "warning"}
            message={
              failed
                ? "Deletion failed after it had already been accepted."
                : "Deletion has already been accepted and cannot be undone."
            }
            description={
              <Space direction="vertical" size={4}>
                {op_id ? (
                  <span>
                    Operation id: <code>{op_id}</code>
                  </span>
                ) : null}
                {error ? (
                  <span>
                    Error: <code>{error}</code>
                  </span>
                ) : null}
                <span>
                  Project id: <code>{project_id}</code>
                </span>
              </Space>
            }
          />
          <Space wrap>
            {failed ? (
              <Button danger onClick={() => setRetryOpen(true)}>
                <Icon name="trash" /> Retry permanent delete
              </Button>
            ) : null}
            <Button
              type={failed ? "default" : "primary"}
              onClick={() => {
                redux.getActions("page").close_project_tab(project_id);
                redux.getActions("page").set_active_tab("projects");
              }}
            >
              <Icon name="arrow-left" /> Back to projects
            </Button>
            <Button
              onClick={() => {
                void navigator?.clipboard?.writeText?.(project_id);
              }}
            >
              <Icon name="copy" /> Copy project id
            </Button>
          </Space>
        </Space>
      </div>
      <HardDeleteProjectModal
        open={retryOpen}
        project_id={project_id}
        title={title}
        onCancel={() => setRetryOpen(false)}
        onDeleted={() => {
          redux.getActions("page").close_project_tab(project_id);
        }}
      />
    </div>
  );
}

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
