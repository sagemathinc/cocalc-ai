import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { ActiveContent } from "./active-content";
import { recordSignedInSurfaceReady } from "./bootstrap-ux-latency";

let disabled: boolean | undefined;
let mockLite = false;
let activeTab = "agents";
let openProjects: string[] = [];
let mockFullscreen: string | undefined;
let mockExam = false;
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));
let accountId: string | undefined;
const accountBindings: Array<{ assertCurrent: () => void }> = [];
const copied = jest.fn();
const actions = { set_active_tab: jest.fn() };
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: { ...require("react"), memo: (component) => component },
  useActions: () => actions,
  redux: { getStore: () => ({ get: () => accountId }) },
  useTypedRedux: (store, field) => {
    if (store === "page" && field === "active_top_tab") return activeTab;
    if (store === "page" && field === "fullscreen") return mockFullscreen;
    if (store === "customize" && field === "exam_mode") return mockExam;
    if (store === "account" && field === "other_settings")
      return disabled === undefined
        ? undefined
        : Map({ openai_disabled: disabled });
    if (field === "is_logged_in") return true;
    if (store === "account" && field === "account_id") return accountId;
    if (field === "open_projects") return openProjects;
  },
}));
jest.mock("@cocalc/frontend/antd-bootstrap", () => ({ Alert: () => null }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/components/loading", () => ({
  Loading: () => null,
}));
jest.mock("@cocalc/frontend/customize", () => ({ SiteName: () => null }));
jest.mock("@cocalc/frontend/docs/link", () => ({ DocsLink: () => null }));
jest.mock("@cocalc/frontend/landing-page/connecting", () => ({
  Connecting: () => null,
}));
jest.mock("./kiosk-mode-banner", () => ({ KioskModeBanner: () => null }));
jest.mock("./managed-egress-blocked-screen", () => ({
  ManagedEgressBlockedScreen: () => null,
}));
jest.mock("./error-boundary", () => ({
  CocalcErrorBoundary: ({ children }) => children,
}));
jest.mock("./bootstrap-ux-latency", () => ({
  recordSignedInSurfaceReady: jest.fn(),
}));
jest.mock("./startup-phase", () => ({ markStartupPhaseOnce: jest.fn() }));
jest.mock("./route-components", () => ({
  ProjectsPage: () => (
    <section aria-label="Projects">
      <input aria-label="Filter projects" />
    </section>
  ),
  ProjectPage: ({ project_id }) => (
    <section aria-label={`Editor ${project_id}`}>
      <input aria-label="Editor text" />
    </section>
  ),
  MyAgentsWorkspacePage: ({ children, contentLabel }) => {
    const { useBoundAgentAccount } = require("../agents/use-bound-account");
    const binding = useBoundAgentAccount();
    accountBindings.push(binding);
    return (
      <div role="region" aria-label="Agents workspace">
        <button
          onClick={() => {
            binding.assertCurrent();
            copied();
          }}
        >
          Copy agent
        </button>
        {contentLabel && <span>{contentLabel}</span>}
        {children}
      </div>
    );
  },
}));

beforeEach(() => {
  mockLite = false;
  activeTab = "agents";
  openProjects = [];
  mockFullscreen = undefined;
  mockExam = false;
  disabled = undefined;
  accountId = undefined;
  accountBindings.length = 0;
  jest.clearAllMocks();
});

it("never mounts Agents when AI is disabled", () => {
  disabled = true;
  render(<ActiveContent />);
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
});

it("unmounts and redirects when the opt-out arrives or changes", () => {
  const { rerender } = render(<ActiveContent />);
  expect(screen.getByRole("region", { name: "Agents workspace" })).toBeTruthy();
  expect(actions.set_active_tab).not.toHaveBeenCalled();
  disabled = true;
  rerender(<ActiveContent />);
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
});

it("marks the Agents workspace ready for browser automation", () => {
  render(<ActiveContent />);
  expect(recordSignedInSurfaceReady).toHaveBeenCalledWith("agents");
});

it("rebinds workspace actions after account loading without reviving old actions", async () => {
  const user = userEvent.setup();
  const { rerender, unmount } = render(<ActiveContent />);
  const beforeLogin = accountBindings.at(-1)!;
  expect(() => beforeLogin.assertCurrent()).toThrow("The account changed");
  accountId = "account-a";
  rerender(<ActiveContent />);
  const accountA = accountBindings.at(-1)!;
  const copy = screen.getByRole("button", { name: "Copy agent" });
  copy.focus();
  await user.keyboard("{Enter}");
  expect(copied).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(copy);
  expect(() => beforeLogin.assertCurrent()).toThrow("The account changed");

  // Ordinary rerenders retain the workspace; an identity change replaces it.
  rerender(<ActiveContent />);
  expect(screen.getByRole("button", { name: "Copy agent" })).toBe(copy);
  accountId = "account-b";
  rerender(<ActiveContent />);
  expect(screen.getByRole("button", { name: "Copy agent" })).not.toBe(copy);
  expect(() => accountA.assertCurrent()).toThrow("The account changed");
  expect(() => accountBindings.at(-1)!.assertCurrent()).not.toThrow();

  accountId = "account-a";
  rerender(<ActiveContent />);
  expect(() => accountA.assertCurrent()).toThrow("The account changed");
  const current = accountBindings.at(-1)!;
  expect(() => current.assertCurrent()).not.toThrow();
  unmount();
  expect(() => current.assertCurrent()).toThrow("The account changed");
});

it("keeps one shell and the same project editor DOM across Projects and agent navigation", async () => {
  const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  accountId = "viewer";
  openProjects = [project];
  activeTab = "projects";
  const { rerender } = render(<ActiveContent />);
  const shell = screen.getByRole("region", { name: "Agents workspace" });
  expect(shell).toContainElement(
    screen.getByRole("region", { name: "Projects" }),
  );
  expect(screen.queryByRole("textbox", { name: "Editor text" })).toBeNull();
  activeTab = project;
  rerender(<ActiveContent />);
  const editor = screen.getByRole("textbox", { name: "Editor text" });
  await userEvent.setup().type(editor, "Unsaved work");
  activeTab = "agents";
  rerender(<ActiveContent />);
  expect(screen.getByRole("region", { name: "Agents workspace" })).toBe(shell);
  expect(editor).toBeInTheDocument();
  expect(editor.closest("[inert]")).not.toBeNull();
  activeTab = project;
  rerender(<ActiveContent />);
  expect(screen.getByRole("textbox", { name: "Editor text" })).toBe(editor);
  expect(editor).toHaveValue("Unsaved work");
  expect(editor.closest("[inert]")).toBeNull();
});

it.each(["AI-disabled", "Lite", "exam", "kiosk", "project"])(
  "retains standalone Projects navigation in %s mode",
  (mode) => {
    activeTab = "projects";
    accountId = "viewer";
    disabled = mode === "AI-disabled";
    mockLite = mode === "Lite";
    mockExam = mode === "exam";
    mockFullscreen = ["kiosk", "project"].includes(mode) ? mode : undefined;
    render(<ActiveContent />);
    expect(
      screen.queryByRole("region", { name: "Agents workspace" }),
    ).toBeNull();
  },
);

it("hides the Projects list without losing its local filter or DOM", () => {
  accountId = "viewer";
  activeTab = "projects";
  const { rerender } = render(<ActiveContent />);
  const filter = screen.getByRole("textbox", {
    name: "Filter projects",
  }) as HTMLInputElement;
  filter.value = "unfinished filter";
  activeTab = "agents";
  rerender(<ActiveContent />);
  expect(filter.isConnected).toBe(true);
  expect(filter.closest("[inert]")).not.toBeNull();
  activeTab = "projects";
  rerender(<ActiveContent />);
  expect(screen.getByRole("textbox", { name: "Filter projects" })).toBe(filter);
  expect(filter.value).toBe("unfinished filter");
});
