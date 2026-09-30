/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
This defines the entire **desktop** Cocalc page layout and brings in
everything on *desktop*, once the user has signed in.
*/

declare var DEBUG: boolean;

import type { IconName } from "@cocalc/frontend/components/icon";

import { Alert, Spin } from "antd";
import { useIntl } from "react-intl";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { AppearanceControl } from "@cocalc/frontend/appearance/control";
import { alert_message } from "@cocalc/frontend/alerts";
import {
  CSS,
  React,
  redux,
  useActions,
  useEffect,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { ClientContext } from "@cocalc/frontend/client/context";
import { Icon } from "@cocalc/frontend/components/icon";
import Next from "@cocalc/frontend/components/next";
import { labels } from "@cocalc/frontend/i18n";
import openSupportTab from "@cocalc/frontend/support/open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { IS_IPAD, IS_MOBILE, IS_SAFARI } from "../feature";
import QuickNavigation from "./quick-navigation";
import { ActiveContent } from "./active-content";
import { usesWorkspaceShell } from "./workspace-shell";
import { HomeWorkspaceNavigation } from "./home-workspace-navigation";
import { ConnectionIndicator } from "./connection-indicator";
import { ConnectionInfo } from "./connection-info";
import { NotificationsDrawer } from "../notifications/drawer";
import { SettingsDrawer } from "../account/settings-drawer";
import { useAppContext } from "./context";
import { CocalcErrorBoundary } from "./error-boundary";
import { FullscreenButton } from "./fullscreen-button";
import { AppLogo } from "./logo";
import { NavTab } from "./nav-tab";
import {
  HIDE_LABEL_THRESHOLD,
  NAV_CLASS,
  shouldHideProjectsLabel,
} from "./top-nav-consts";
import VersionWarning from "./version-warning";
import { lite } from "@cocalc/frontend/lite";
import { ImpersonationBanner } from "./impersonation-banner";
import { useVisibleViewportBottom } from "./visible-viewport";
import { ScratchpadSessionControls } from "./scratchpad-session-controls";
import { recordSignedInAppBootstrapReady } from "./bootstrap-ux-latency";
import { configureUxLatency } from "@cocalc/frontend/monitoring/ux-latency";
import { configureOnboardingMonitoring } from "@cocalc/frontend/monitoring/onboarding";
import {
  getStoredProjectsNavMode,
  type ProjectsNavMode,
} from "@cocalc/frontend/projects/projects-nav-mode";
import { lazyWithRetry } from "./lazy-with-retry";
import usePostSurfaceWork from "./use-post-surface-work";
import useSignedInSurfaceReady from "./use-signed-in-surface-ready";
import useStartupPerformancePolicy from "./use-startup-performance-policy";

const PostSurfaceRightNav = lazyWithRetry(async () => {
  const [{ ensureNotificationsInitialized }, postSurface] = await Promise.all([
    import("@cocalc/frontend/notifications/ensure-init"),
    import("./post-surface-right-nav"),
  ]);
  await ensureNotificationsInitialized();
  return { default: postSurface.PostSurfaceRightNav };
}, "post-surface navigation");
const PostSurfaceProjectsNav = lazyWithRetry(
  async () => ({
    default: (await import("@cocalc/frontend/projects/projects-nav"))
      .ProjectsNav,
  }),
  "post-surface project navigation",
);
const PostSurfaceBanners = lazyWithRetry(
  async () => ({
    default: (await import("./post-surface-banners")).PostSurfaceBanners,
  }),
  "post-surface banners",
);
const PostSurfaceModals = lazyWithRetry(
  async () => ({
    default: (await import("./post-surface-modals")).PostSurfaceModals,
  }),
  "post-surface modals",
);

// Mobile browsers (iOS Safari, iPadOS, Android) make the layout viewport
// (100vh) taller than the visible area when browser chrome or the software
// keyboard is showing, and let the page scroll even with overflow:hidden.
// See https://lukechannings.com/blog/2021-06-09-does-safari-15-fix-the-vh-bug/
// On touch devices Page overrides this with the live Visual Viewport bottom
// edge; 100dvh is the fallback. (iOS previously used 100vh minus a fixed
// 80px, which left a large blank band below the page.)
const TRACK_VISIBLE_VIEWPORT = IS_MOBILE || IS_IPAD;
const PAGE_HEIGHT: string =
  TRACK_VISIBLE_VIEWPORT || IS_SAFARI
    ? "calc(100dvh - env(safe-area-inset-bottom))"
    : "100vh";

const PAGE_STYLE: CSS = {
  display: "flex",
  flexDirection: "column",
  height: PAGE_HEIGHT, // see note
  width: "100vw",
  overflow: "hidden",
  background: UI_COLORS.page,
} as const;

function PostSurfaceSlot({
  children,
  scope,
}: {
  children: React.ReactNode;
  scope: string;
}) {
  return (
    <CocalcErrorBoundary fallback={null} scope={scope}>
      <React.Suspense fallback={null}>{children}</React.Suspense>
    </CocalcErrorBoundary>
  );
}

function signInHrefWithCurrentTarget(): string {
  if (typeof window === "undefined") {
    return "/auth/sign-in";
  }
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (!target || target === "/" || target.startsWith("/auth/")) {
    return "/auth/sign-in";
  }
  return `/auth/sign-in?target=${encodeURIComponent(target)}`;
}

function useClientSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState<boolean>(() =>
    webapp_client.is_signed_in(),
  );

  useEffect(() => {
    const update = () => setSignedIn(webapp_client.is_signed_in());
    update();
    webapp_client.on("signed_in", update);
    webapp_client.on("signed_out", update);
    webapp_client.on("remember_me_failed", update);
    return () => {
      webapp_client.off("signed_in", update);
      webapp_client.off("signed_out", update);
      webapp_client.off("remember_me_failed", update);
    };
  }, []);

  return signedIn;
}

export const Page: React.FC = () => {
  const page_actions = useActions("page");
  const visibleViewportBottom = useVisibleViewportBottom(
    TRACK_VISIBLE_VIEWPORT,
  );
  const surfaceReady = useSignedInSurfaceReady();
  const startupPerformance = useStartupPerformancePolicy();
  const showPostSurfaceNavigation = usePostSurfaceWork({
    mode: startupPerformance.mode,
    surfaceReady,
    work: "navigation",
  });
  const showPostSurfaceModals = usePostSurfaceWork({
    mode: startupPerformance.mode,
    surfaceReady,
    work: "modals",
  });
  const requestedSettingsModal = useTypedRedux("page", "settingsModal");
  const showPostSurfaceBanners = usePostSurfaceWork({
    mode: startupPerformance.mode,
    surfaceReady,
    work: "banners",
  });

  const { pageStyle } = useAppContext();
  const { isNarrow, topBarStyle, projectsNavStyle } = pageStyle;

  const intl = useIntl();

  const open_projects = useTypedRedux("projects", "open_projects");
  const [projectsNavMode, setProjectsNavMode] = useState<ProjectsNavMode>(
    getStoredProjectsNavMode,
  );
  const [show_label, set_show_label] = useState<boolean>(true);
  useEffect(() => {
    const next = open_projects.size <= HIDE_LABEL_THRESHOLD;
    if (next != show_label) {
      set_show_label(next);
    }
  }, [open_projects]);

  useEffect(() => {
    return () => {
      page_actions.clear_all_handlers();
    };
  }, []);

  const [showSignInTab, setShowSignInTab] = useState<boolean>(false);
  useEffect(() => {
    const timeout = setTimeout(() => setShowSignInTab(true), 3000);
    return () => clearTimeout(timeout);
  }, []);

  const active_top_tab = useTypedRedux("page", "active_top_tab");
  const otherSettings = useTypedRedux("account", "other_settings");
  const aiDisabled = !!otherSettings?.get("openai_disabled");
  const compactAgentsNavigation = active_top_tab === "agents";
  const isAuthView = active_top_tab === "auth";
  const show_mentions = active_top_tab === "notifications";
  const show_connection = useTypedRedux("page", "show_connection");
  const fullscreen = useTypedRedux("page", "fullscreen");
  const local_storage_warning = useTypedRedux("page", "local_storage_warning");
  const cookie_warning = useTypedRedux("page", "cookie_warning");
  const accountIsReady = useTypedRedux("account", "is_ready");
  const customizeReady = useTypedRedux("customize", "_is_configured");
  const uxLatencyTelemetryEnabled = useTypedRedux(
    "customize",
    "ux_latency_telemetry_enabled",
  );
  const uxLatencySuccessSampleRate = useTypedRedux(
    "customize",
    "ux_latency_success_sample_rate",
  );
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const examMode = useTypedRedux("customize", "exam_mode") === true;
  const workspaceShell = usesWorkspaceShell({
    lite,
    aiDisabled,
    signedIn: !!is_logged_in,
    examMode,
    fullscreen,
    activeTab: active_top_tab,
  });
  const configurationLoadError = useTypedRedux(
    "customize",
    "configuration_load_error",
  );
  const examProjectId = useTypedRedux("customize", "project_id");
  const scratchpadDeleteAt = useTypedRedux(
    "customize",
    "scratchpad_delete_at" as any,
  ) as string | undefined;
  const clientSignedIn = useClientSignedIn();
  const effectivelySignedIn = is_logged_in || clientSignedIn;
  const groups = useTypedRedux("account", "groups");
  const zendesk = !!useTypedRedux("customize", "zendesk");

  useEffect(() => {
    configureOnboardingMonitoring(
      effectivelySignedIn && accountIsReady ? account_id : undefined,
      !!customizeReady && uxLatencyTelemetryEnabled === true,
    );
  }, [
    account_id,
    accountIsReady,
    customizeReady,
    effectivelySignedIn,
    uxLatencyTelemetryEnabled,
  ]);

  useEffect(() => {
    if (!accountIsReady || !customizeReady || !effectivelySignedIn) return;
    configureUxLatency({
      telemetry_enabled: uxLatencyTelemetryEnabled,
      success_sample_rate: uxLatencySuccessSampleRate,
    });
    return recordSignedInAppBootstrapReady();
  }, [
    accountIsReady,
    customizeReady,
    effectivelySignedIn,
    uxLatencySuccessSampleRate,
    uxLatencyTelemetryEnabled,
  ]);

  useEffect(() => {
    if (!examMode || !examProjectId || active_top_tab === examProjectId) return;
    void redux.getActions("projects").open_project({
      project_id: examProjectId,
      switch_to: true,
    });
  }, [active_top_tab, examMode, examProjectId]);

  function account_tab_icon(): IconName | React.JSX.Element {
    if (account_id) {
      return (
        <Avatar
          size={20}
          account_id={account_id}
          no_tooltip={true}
          no_loading={true}
        />
      );
    } else {
      return "cog";
    }
  }

  function render_account_tab(): React.JSX.Element {
    if (!accountIsReady) {
      return (
        <div>
          <Spin delay={1000} />
        </div>
      );
    }
    const icon = account_tab_icon();
    return (
      <NavTab
        name="account"
        label_class={NAV_CLASS}
        icon={icon}
        active_top_tab={active_top_tab}
        hide_label={!show_label}
        on_click={() => {
          openAccountSettings({ page: "index" }, { changeHistory: false });
        }}
        tooltip={intl.formatMessage(labels.account)}
      />
    );
  }

  function render_admin_tab(): React.JSX.Element | undefined {
    if (is_logged_in && groups?.includes("admin")) {
      return (
        <NavTab
          name="admin"
          label_class={NAV_CLASS}
          icon={"users"}
          active_top_tab={active_top_tab}
          hide_label={!show_label}
        />
      );
    }
  }

  function render_docs_tab(): React.JSX.Element | undefined {
    if (!is_logged_in) return;
    return (
      <NavTab
        name="docs"
        label="Docs"
        label_class={NAV_CLASS}
        icon={"book"}
        active_top_tab={active_top_tab}
        hide_label={true}
        ariaLabel="Docs"
        tooltip="Search CoCalc documentation"
      />
    );
  }

  function render_hosts_tab(): React.JSX.Element | null {
    if (!is_logged_in) return null;
    return (
      <NavTab
        name="hosts"
        label="Compute"
        label_class={NAV_CLASS}
        icon={"server"}
        active_top_tab={active_top_tab}
        hide_label
        ariaLabel="Compute"
        tooltip="Manage project hosts and virtual machines"
      />
    );
  }

  function render_sign_in_tab(): React.JSX.Element | null {
    if (lite || effectivelySignedIn || !showSignInTab) {
      return null;
    }

    return (
      <Next
        sameTab
        href={signInHrefWithCurrentTarget()}
        style={{
          backgroundColor: UI_COLORS.warningBg,
          fontSize: "16pt",
          color: UI_COLORS.warning,
          padding: "5px 15px",
        }}
      >
        <Icon name="sign-in" />{" "}
        {intl.formatMessage({
          id: "page.sign_in.label",
          defaultMessage: "Sign in",
        })}
      </Next>
    );
  }

  function render_support(): React.JSX.Element | undefined {
    if (!zendesk || !is_logged_in) {
      return;
    }
    return (
      <NavTab
        name={undefined} // does not open a tab, just a popup
        active_top_tab={active_top_tab} // it's never supposed to be active!
        label_class={NAV_CLASS}
        icon={"support"}
        on_click={openSupportTab}
        hide_label={true}
        tooltip={intl.formatMessage({
          id: "page.help.label",
          defaultMessage: "Help",
        })}
      />
    );
  }

  function render_fullscreen(): React.JSX.Element | undefined {
    if (isNarrow) return;

    return <FullscreenButton pageStyle={pageStyle} />;
  }

  function render_right_nav(): React.JSX.Element {
    return (
      <div
        className="smc-right-tabs-fixed"
        style={{
          display: "flex",
          flex: "0 0 auto",
          height: `${pageStyle.height}px`,
          margin: "0",
          overflowY: "hidden",
          alignItems: "center",
        }}
      >
        {render_admin_tab()}
        {render_sign_in_tab()}
        {is_logged_in ? render_account_tab() : undefined}
        {showPostSurfaceNavigation ? (
          <PostSurfaceSlot scope="app.post-surface-right-nav">
            <PostSurfaceRightNav
              isLoggedIn={is_logged_in}
              pageStyle={pageStyle}
              showMentions={show_mentions}
            />
          </PostSurfaceSlot>
        ) : undefined}
        {render_docs_tab()}
        {render_support()}
        <AppearanceControl compact />
        <ConnectionIndicator height={pageStyle.height} pageStyle={pageStyle} />
        {render_fullscreen()}
      </div>
    );
  }

  function render_project_nav_button(): React.JSX.Element {
    return (
      <NavTab
        style={{
          height: `${pageStyle.height}px`,
          margin: "0",
          overflow: "hidden",
        }}
        name={"projects"}
        active_top_tab={active_top_tab}
        tooltip={intl.formatMessage({
          id: "page.project_nav.tooltip",
          defaultMessage: "Show all the projects on which you collaborate.",
        })}
        icon="folder-open"
        label={intl.formatMessage(labels.projects)}
        hide_label={
          workspaceShell ||
          shouldHideProjectsLabel(
            open_projects.size,
            isNarrow,
            projectsNavMode === "tabs",
          )
        }
        ariaLabel={intl.formatMessage(labels.projects)}
      />
    );
  }

  function render_people_nav_button(): React.JSX.Element | null {
    if (lite) return null;
    return (
      <NavTab
        style={{
          height: `${pageStyle.height}px`,
          margin: "0",
          overflow: "hidden",
        }}
        name="people"
        active_top_tab={active_top_tab}
        tooltip="Conversations with the people you collaborate with"
        icon="users"
        label="People"
        hide_label={isNarrow}
        ariaLabel="People"
      />
    );
  }

  function render_agents_nav_button(): React.JSX.Element | null {
    if (aiDisabled) return null;
    return (
      <NavTab
        style={{
          height: `${pageStyle.height}px`,
          margin: "0",
          overflow: "hidden",
        }}
        name="agents"
        active_top_tab={active_top_tab}
        tooltip="Work with registered agents, chats, artifacts, and terminals"
        icon="robot"
        label="Agents"
        hide_label={isNarrow}
        ariaLabel="Agents"
      />
    );
  }

  // register a default drag and drop handler, that prevents
  // accidental file drops
  // TEST: make sure that usual drag'n'drop activities
  // like rearranging tabs and reordering tasks work
  function drop(e) {
    if (DEBUG) {
      e.persist();
    }
    //console.log "react desktop_app.drop", e
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      alert_message({
        type: "info",
        title: "File Drop Rejected",
        message:
          'To upload a file, drop it onto a file you are editing, the file explorer listing or the "Drop files to upload" area in the +New page.',
      });
    }
  }

  // Children must define their own padding from navbar and screen borders
  // Note that the parent is a flex container
  // In the workspace shell this navigation renders inside the content pane,
  // beside the agent sidebar, instead of across the top of the page.
  const legacyNavigation = (
    <>
      {!lite &&
        !examMode &&
        !fullscreen &&
        !isAuthView &&
        !compactAgentsNavigation && (
          <nav className="smc-top-bar" style={topBarStyle}>
            {!workspaceShell && <AppLogo size={pageStyle.height} />}
            {!workspaceShell && is_logged_in && render_agents_nav_button()}
            {!workspaceShell && is_logged_in && render_people_nav_button()}
            {is_logged_in && render_project_nav_button()}
            {render_hosts_tab()}
            {!isNarrow ? (
              showPostSurfaceNavigation ? (
                <PostSurfaceSlot scope="app.post-surface-project-navigation">
                  <PostSurfaceProjectsNav
                    height={pageStyle.height}
                    onModeChange={setProjectsNavMode}
                    style={projectsNavStyle}
                  />
                </PostSurfaceSlot>
              ) : (
                <div style={{ ...projectsNavStyle, flex: "1 1 auto" }} />
              )
            ) : (
              // we need an expandable placeholder, otherwise the right-nav-buttons won't align to the right
              <div style={{ flex: "1 1 auto" }} />
            )}
            {workspaceShell && isNarrow ? (
              <HomeWorkspaceNavigation />
            ) : (
              render_right_nav()
            )}
          </nav>
        )}
      {!lite &&
        !examMode &&
        isNarrow &&
        !isAuthView &&
        !compactAgentsNavigation && (
          <>
            {showPostSurfaceNavigation ? (
              <PostSurfaceSlot scope="app.post-surface-project-navigation-narrow">
                <PostSurfaceProjectsNav
                  height={pageStyle.height}
                  onModeChange={setProjectsNavMode}
                  style={projectsNavStyle}
                />
              </PostSurfaceSlot>
            ) : (
              <div style={{ ...projectsNavStyle, height: pageStyle.height }} />
            )}
          </>
        )}
    </>
  );
  const body = (
    <div
      style={
        visibleViewportBottom == null
          ? PAGE_STYLE
          : { ...PAGE_STYLE, height: `${visibleViewportBottom}px` }
      }
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
    >
      {show_connection && <ConnectionInfo />}
      <NotificationsDrawer />
      <SettingsDrawer />
      <VersionWarning />
      {showPostSurfaceBanners ? (
        <PostSurfaceSlot scope="app.post-surface-banners">
          <PostSurfaceBanners
            cookieWarning={!!cookie_warning}
            fullscreen={!!fullscreen}
            localStorageWarning={!!local_storage_warning}
          />
        </PostSurfaceSlot>
      ) : undefined}
      {configurationLoadError && (
        <Alert banner showIcon type="error" title={configurationLoadError} />
      )}
      <ImpersonationBanner />
      {!workspaceShell && legacyNavigation}
      {fullscreen && !isAuthView && render_fullscreen()}
      {examMode && !isAuthView && (
        <ScratchpadSessionControls deleteAt={scratchpadDeleteAt} />
      )}
      <CocalcErrorBoundary
        autoRetry={false}
        scope="app.active-content"
        resetKeys={[active_top_tab]}
      >
        <ActiveContent
          navigation={workspaceShell ? legacyNavigation : undefined}
        />
      </CocalcErrorBoundary>
      {/* Embedded surfaces (kiosk and project embed) and the auth view hide
          the top navigation and confine what may be shown; keep the global
          shortcut off there too. Plain fullscreen keeps it. */}
      {!examMode &&
        !isAuthView &&
        fullscreen !== "kiosk" &&
        fullscreen !== "project" && <QuickNavigation />}
      {(showPostSurfaceModals || !!requestedSettingsModal) && !examMode ? (
        <PostSurfaceSlot scope="app.post-surface-modals">
          <PostSurfaceModals />
        </PostSurfaceSlot>
      ) : undefined}
    </div>
  );
  return (
    <ClientContext.Provider value={{ client: webapp_client }}>
      {body}
    </ClientContext.Provider>
  );
};
