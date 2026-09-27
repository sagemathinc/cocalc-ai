import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { ActiveContent } from "./active-content";

let disabled: boolean | undefined;
let mockLite = false;
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));
let activeTab = "agents";
let collaboratorsOpen = false;
let collaboratorsEnabled = false;
let customizeReady = true;
const collaborationProps = jest.fn();
const openCollaborators = jest.fn();
const actions = { set_active_tab: jest.fn() };
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: { ...require("react"), memo: (component) => component },
  useActions: () => actions,
  useTypedRedux: (store, field) => {
    if (store === "page" && field === "active_top_tab") return activeTab;
    if (store === "page" && field === "collaborators_open")
      return collaboratorsOpen;
    if (store === "page" && field === "collaborators_view") return "people";
    if (store === "page" && field === "collaborators_project_id")
      return "project-id";
    if (store === "page" && field === "collaborators_person_id")
      return "person-id";
    if (store === "page" && field === "collaborators_resource_kind")
      return "conversation";
    if (store === "page" && field === "collaborators_resource_id")
      return "thread-id";
    if (store === "customize" && field === "collaborators_enabled")
      return collaboratorsEnabled;
    if (store === "customize" && field === "_is_configured")
      return customizeReady;
    if (store === "account" && field === "account_id") return "viewer";
    if (store === "account" && field === "other_settings")
      return disabled === undefined
        ? undefined
        : Map({ openai_disabled: disabled });
    if (field === "is_logged_in") return true;
    if (field === "open_projects") return [];
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
  ProjectsPage: () => <section aria-label="Projects" />,
  MyAgentsWorkspacePage: () => (
    <div role="region" aria-label="Agents workspace" />
  ),
}));

beforeEach(() => {
  mockLite = false;
  disabled = undefined;
  activeTab = "agents";
  collaboratorsOpen = false;
  collaboratorsEnabled = false;
  customizeReady = true;
  jest.clearAllMocks();
});

it.each(["AI-disabled", "Lite"])(
  "opens feature-enabled human discovery without mounting Agents in %s",
  async (mode) => {
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
