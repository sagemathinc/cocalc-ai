import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { IntlProvider } from "react-intl";
import { Page } from "./page";

let activeTab = "projects";
let narrow = false;
let fullscreen: string | undefined;
let examMode = false;
let isLite = false;
let loggedIn = true;
let aiDisabled = false;
const actions = { set_active_tab: jest.fn(), clear_all_handlers: jest.fn() };
const openProjects = { size: 0 };
const topBarStyle = { display: "flex", height: 36 };

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("react"),
  React: require("react"),
  useActions: () => actions,
  useTypedRedux: (store, field) => {
    if (store === "page" && field === "active_top_tab") return activeTab;
    if (field === "open_projects") return openProjects;
    if (field === "other_settings") return Map({ openai_disabled: aiDisabled });
    if (field === "is_logged_in") return loggedIn;
    if (field === "fullscreen") return fullscreen;
    if (field === "exam_mode") return examMode;
  },
}));
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return isLite;
  },
}));
jest.mock("../feature", () => ({
  IS_ANDROID: false,
  IS_IOS: false,
  IS_MOBILE: false,
  IS_SAFARI: false,
}));
jest.mock("./context", () => ({
  useAppContext: () => ({
    pageStyle: { isNarrow: narrow, height: 36, topBarStyle },
  }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, ...props }) => <a {...props}>{children}</a>,
  Icon: ({ name }) => <span data-icon={name} />,
  Tooltip: ({ children }) => children,
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("../art", () => ({ APP_ICON: "logo.svg" }));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    is_signed_in: () => loggedIn,
    on: jest.fn(),
    off: jest.fn(),
  },
}));
jest.mock("@cocalc/frontend/client/context", () => ({
  ClientContext: require("react").createContext({}),
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));
jest.mock("@cocalc/frontend/appearance/control", () => ({
  AppearanceControl: () => <button>Appearance</button>,
}));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock("@cocalc/frontend/components/next", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@cocalc/frontend/support/open", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./quick-navigation", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("./active-content", () => ({
  ActiveContent: () => <div>Active content</div>,
}));
jest.mock("./connection-indicator", () => ({
  ConnectionIndicator: () => null,
}));
jest.mock("./connection-info", () => ({ ConnectionInfo: () => null }));
jest.mock("../notifications/drawer", () => ({
  NotificationsDrawer: () => null,
}));
jest.mock("../account/settings-drawer", () => ({ SettingsDrawer: () => null }));
jest.mock("./error-boundary", () => ({
  CocalcErrorBoundary: ({ children }) => children,
}));
jest.mock("./fullscreen-button", () => ({ FullscreenButton: () => null }));
jest.mock("./version-warning", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("./impersonation-banner", () => ({
  ImpersonationBanner: () => null,
}));
jest.mock("./visible-viewport", () => ({
  useVisibleViewportBottom: () => undefined,
}));
jest.mock("./scratchpad-session-controls", () => ({
  ScratchpadSessionControls: () => null,
}));
jest.mock("./bootstrap-ux-latency", () => ({
  recordSignedInAppBootstrapReady: jest.fn(),
}));
jest.mock("@cocalc/frontend/monitoring/ux-latency", () => ({
  configureUxLatency: jest.fn(),
}));
jest.mock("@cocalc/frontend/projects/projects-nav-mode", () => ({
  getStoredProjectsNavMode: () => "tabs",
}));
jest.mock("./lazy-with-retry", () => ({
  lazyWithRetry: (_load, label) => () => (
    <div role="region" aria-label={label} />
  ),
}));
jest.mock("./use-post-surface-work", () => ({
  __esModule: true,
  default: () => true,
}));
jest.mock("./use-signed-in-surface-ready", () => ({
  __esModule: true,
  default: () => true,
}));
jest.mock("./use-startup-performance-policy", () => ({
  __esModule: true,
  default: () => ({ mode: "normal" }),
}));

function view() {
  return (
    <IntlProvider locale="en">
      <Page />
    </IntlProvider>
  );
}

beforeEach(() => {
  activeTab = "projects";
  narrow = false;
  fullscreen = undefined;
  examMode = false;
  isLite = false;
  loggedIn = true;
  aiDisabled = false;
  jest.clearAllMocks();
});

test.each([false, true])(
  "Agents hides the full navigation and Projects restores it (narrow=%s)",
  async (isNarrow) => {
    narrow = isNarrow;
    const mounted = render(view());
    const nav = screen.getByRole("navigation");
    const logo = within(nav).getByRole("link", { name: "CoCalc home" });
    const agents = within(nav).getByRole("button", { name: "Agents" });
    const projects = within(nav).getByRole("button", { name: "Projects" });
    const hosts = within(nav).getByRole("button", { name: "Compute" });
    const segment = [logo, agents, projects, hosts];
    expect(Array.from(nav.children).slice(0, 4)).toEqual(segment);
    expect(
      screen.getByRole("region", { name: "post-surface project navigation" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Docs" })).toBeVisible();
    const user = userEvent.setup();
    agents.focus();
    await user.keyboard("{Enter}");
    expect(actions.set_active_tab).toHaveBeenCalledWith("agents");
    activeTab = "agents";
    mounted.rerender(view());
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Docs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Appearance" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "post-surface project navigation" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "post-surface navigation" }),
    ).toBeNull();
    activeTab = "projects";
    mounted.rerender(view());
    expect(screen.getByRole("navigation")).toBeVisible();
    expect(screen.getByRole("button", { name: "Compute" })).toBeVisible();
  },
);

test.each(["lite", "exam", "fullscreen", "auth"])(
  "retained navigation respects %s visibility",
  (mode) => {
    activeTab = mode === "auth" ? "auth" : "projects";
    isLite = mode === "lite";
    examMode = mode === "exam";
    fullscreen = mode === "fullscreen" ? "default" : undefined;
    render(view());
    expect(screen.queryByRole("navigation")).toBeNull();
  },
);

test("retained tabs preserve login and AI visibility", () => {
  activeTab = "projects";
  loggedIn = false;
  const mounted = render(view());
  expect(screen.getByRole("link", { name: "CoCalc home" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Compute" })).toBeNull();
  loggedIn = true;
  aiDisabled = true;
  mounted.rerender(view());
  expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  expect(screen.getByRole("button", { name: "Projects" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Compute" })).toBeVisible();
});
