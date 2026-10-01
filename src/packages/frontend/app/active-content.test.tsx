import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { ActiveContent } from "./active-content";
import { recordSignedInSurfaceReady } from "./bootstrap-ux-latency";

jest.mock("@cocalc/frontend/docs/drawer", () => ({
  AppDocsDrawer: () => null,
}));

let disabled: boolean | undefined;
let mockLite = false;
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));
let activeTab = "agents";
let openProjects: string[] = [];
let mockFullscreen: string | undefined;
let mockExam = false;
let collaboratorsOpen = false;
let collaboratorsEnabled = false;
let contactId: string | undefined;
let invitationId: string | undefined;
let customizeReady = true;
const collaborationProps = jest.fn();
const openCollaborators = jest.fn();
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
    if (store === "page" && field === "collaborators_open")
      return collaboratorsOpen;
    if (store === "page" && field === "collaborators_view")
      return invitationId ? "invites" : "people";
    if (store === "page" && field === "collaborators_invitation_id")
      return invitationId;
    if (store === "page" && field === "collaborators_project_id")
      return "project-id";
    if (store === "page" && field === "collaborators_person_id")
      return contactId ? undefined : "person-id";
    if (store === "page" && field === "collaborators_contact_id")
      return contactId;
    if (store === "page" && field === "collaborators_resource_kind")
      return "conversation";
    if (store === "page" && field === "collaborators_resource_id")
      return "thread-id";
    if (store === "customize" && field === "collaborators_enabled")
      return collaboratorsEnabled;
    if (store === "customize" && field === "_is_configured")
      return customizeReady;
    if (store === "account" && field === "other_settings")
      return disabled === undefined
        ? undefined
        : Map({ openai_disabled: disabled });
    if (field === "is_logged_in") return true;
    if (store === "account" && field === "account_id") return accountId;
    if (field === "open_projects") return openProjects;
    if (store === "page" && field === "fullscreen") return mockFullscreen;
    if (store === "customize" && field === "exam_mode") return mockExam;
  },
}));
jest.mock("@cocalc/frontend/collaborators/navigation", () => ({
  openCollaborators: (...args) => openCollaborators(...args),
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
  CollaboratorsPage: (props) => {
    collaborationProps(props);
    return (
      <section aria-label="Human collaboration workspace">
        {props.navigation}
        <button
          onClick={() =>
            props.onNavigate({ view: "projects", personId: props.personId })
          }
        >
          View shared projects
        </button>
      </section>
    );
  },
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
        {contentLabel && <span>{contentLabel}</span>}
        {children}
        <button
          onClick={() => {
            binding.assertCurrent();
            copied();
          }}
        >
          Copy agent
        </button>
      </div>
    );
  },
}));

beforeEach(() => {
  mockLite = false;
  openProjects = [];
  mockFullscreen = undefined;
  mockExam = false;
  disabled = undefined;
  activeTab = "agents";
  collaboratorsOpen = false;
  collaboratorsEnabled = false;
  contactId = undefined;
  invitationId = undefined;
  customizeReady = true;
  accountId = undefined;
  accountBindings.length = 0;
  jest.clearAllMocks();
});

it.each(["AI-disabled", "Lite"])(
  "passes a contact selection separately from account people to the %s shell",
  (mode) => {
    disabled = mode === "AI-disabled";
    mockLite = mode === "Lite";
    accountId = "viewer";
    collaboratorsOpen = true;
    collaboratorsEnabled = true;
    contactId = "33333333-3333-4333-8333-333333333333";
    render(<ActiveContent />);
    expect(collaborationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactId, personId: undefined }),
    );
  },
);

it.each(["AI-disabled", "Lite"])(
  "opens feature-enabled human discovery without mounting Agents in %s",
  async (mode) => {
    accountId = "viewer";
    disabled = mode === "AI-disabled";
    mockLite = mode === "Lite";
    collaboratorsOpen = true;
    collaboratorsEnabled = true;
    render(<ActiveContent />);
    expect(
      screen.getByRole("region", { name: "Human collaboration workspace" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Agents workspace" }),
    ).toBeNull();
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    expect(recordSignedInSurfaceReady).toHaveBeenCalledWith("collaborators");
    expect(recordSignedInSurfaceReady).not.toHaveBeenCalledWith("agents");
    expect(collaborationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        accountId: "viewer",
        view: "people",
        projectId: "project-id",
        personId: "person-id",
        resourceKind: "conversation",
        resourceId: "thread-id",
      }),
    );
    const user = userEvent.setup();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Back to projects" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
    await user.tab();
    expect(
      screen.getByRole("button", { name: "View shared projects" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(openCollaborators).toHaveBeenCalledWith({
      view: "projects",
      personId: "person-id",
    });
  },
);

it.each(["AI-disabled", "Lite"])(
  "retains the human route while settings load and honors the feature flag in %s",
  (mode) => {
    disabled = mode === "AI-disabled";
    mockLite = mode === "Lite";
    collaboratorsOpen = true;
    customizeReady = false;
    const { rerender } = render(<ActiveContent />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading site settings",
    );
    expect(collaborationProps).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Agents workspace" }),
    ).toBeNull();
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    customizeReady = true;
    rerender(<ActiveContent />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "not enabled on this site",
    );
    expect(collaborationProps).not.toHaveBeenCalled();
    expect(actions.set_active_tab).not.toHaveBeenCalled();
    collaboratorsEnabled = true;
    rerender(<ActiveContent />);
    expect(
      screen.getByRole("region", { name: "Human collaboration workspace" }),
    ).toBeVisible();
    expect(actions.set_active_tab).not.toHaveBeenCalled();
  },
);

it("updates invitation props without remounting the active People workspace", () => {
  disabled = true;
  collaboratorsOpen = true;
  collaboratorsEnabled = true;
  invitationId = "11111111-1111-4111-8111-111111111111";
  const { rerender } = render(<ActiveContent />);
  const workspace = screen.getByRole("region", {
    name: "Human collaboration workspace",
  });
  expect(collaborationProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ invitationId, view: "invites" }),
  );
  invitationId = "22222222-2222-4222-8222-222222222222";
  rerender(<ActiveContent />);
  expect(collaborationProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ invitationId, view: "invites" }),
  );
  expect(
    screen.getByRole("region", { name: "Human collaboration workspace" }),
  ).toBe(workspace);
  invitationId = undefined;
  rerender(<ActiveContent />);
  expect(collaborationProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ invitationId: undefined }),
  );
});

it("switches an open Collaborators route to the human shell when AI opt-out arrives", () => {
  collaboratorsOpen = true;
  collaboratorsEnabled = true;
  const { rerender } = render(<ActiveContent />);
  expect(
    screen.getByRole("region", { name: "Agents workspace" }),
  ).toBeVisible();
  disabled = true;
  rerender(<ActiveContent />);
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Human collaboration workspace" }),
  ).toBeVisible();
  expect(actions.set_active_tab).not.toHaveBeenCalled();
  activeTab = "projects";
  rerender(<ActiveContent />);
  expect(
    screen.queryByRole("region", { name: "Human collaboration workspace" }),
  ).toBeNull();
  expect(collaborationProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ active: false }),
  );
});

it("does not let the Collaborators feature flag enable the ordinary Agents route", () => {
  disabled = true;
  collaboratorsEnabled = true;
  render(<ActiveContent />);
  expect(collaborationProps).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
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

it.each(["AI-disabled", "Lite"])(
  "rebinds Agents after switching accounts in the %s human workspace",
  async (mode) => {
    const user = userEvent.setup();
    accountId = "account-a";
    const { rerender } = render(<ActiveContent />);
    const accountA = accountBindings.at(-1)!;
    expect(() => accountA.assertCurrent()).not.toThrow();

    disabled = mode === "AI-disabled";
    mockLite = mode === "Lite";
    collaboratorsOpen = true;
    collaboratorsEnabled = true;
    rerender(<ActiveContent />);
    expect(
      screen.getByRole("region", { name: "Human collaboration workspace" }),
    ).toBeVisible();
    expect(() => accountA.assertCurrent()).toThrow("The account changed");

    accountId = "account-b";
    rerender(<ActiveContent />);
    expect(collaborationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: "account-b", active: true }),
    );

    collaboratorsOpen = false;
    disabled = false;
    rerender(<ActiveContent />);
    expect(
      screen.queryByRole("region", { name: "Human collaboration workspace" }),
    ).toBeNull();
    expect(() => accountBindings.at(-1)!.assertCurrent()).not.toThrow();
    expect(() => accountA.assertCurrent()).toThrow("The account changed");
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy agent" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(copied).toHaveBeenCalledTimes(1);
  },
);

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
