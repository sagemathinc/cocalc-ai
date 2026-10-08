import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentNetworkDirectory,
  NamedAgentDirectory,
} from "@cocalc/conat/agents/personal";
import { ConnectorsPage as ConnectionsPage } from "./connectors-page";
import { getVisibleSettingsNavigation } from "./settings-navigation";
import { refreshCliConnectors } from "@cocalc/frontend/agents/cli-connectors";

const SETUP = {
  github: { available: true, app_url: "https://github.com/apps/cocalc-test" },
  cloudflare: { available: false },
};
const mockApi = {
  listCliConnections: jest.fn(),
  listCliConnectorGrants: jest.fn(),
  getCliConnectorSetup: jest.fn(),
  startCliConnectorSignIn: jest.fn(),
  pollCliConnectorSignIn: jest.fn(),
  saveCliConnectorGrant: jest.fn(),
  disconnectCliConnection: jest.fn(),
  listCocalcConnectorConfigs: jest.fn(),
  getCocalcConnectorConfig: jest.fn(),
  saveCocalcConnectorConfig: jest.fn(),
  removeCocalcConnectorConfig: jest.fn(),
  updateAgentNetwork: jest.fn(),
  setPersonalMessagingState: jest.fn(),
};
let mockAgents: { directory?: NamedAgentDirectory; error?: string };
let mockNetworks: { directory?: AgentNetworkDirectory; error?: string };
const mockRefreshNetworks = jest.fn();
// The site has both connectors set up unless a test says otherwise, and the
// agent's project has internet access.
const mockSiteConnectors: Record<string, boolean> = {
  cli_connector_github_enabled: true,
  cli_connector_cloudflare_enabled: true,
};
let mockRunQuota: any = { network: true };
jest.mock("@cocalc/frontend/project/use-project-run-quota", () => ({
  useProjectRunQuota: () => ({ runQuota: mockRunQuota }),
}));
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => mockApi,
  useNamedAgents: () => mockAgents,
  useAgentNetworks: () => mockNetworks,
  refreshAgentNetworks: () => mockRefreshNetworks(),
  refreshNamedAgents: () => mockRefreshNetworks(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
}));
const mockOpenSettings = jest.fn();
jest.mock("./settings-routing", () => ({
  openAccountSettings: (...args) => mockOpenSettings(...args),
}));
const mockFreshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action) => mockFreshAuth(action),
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/components/api-key-scope-editor", () => ({
  EMPTY_API_KEY_SCOPE: { version: 1, account: [], projects: [] },
  ApiKeyScopeEditor: () => null,
}));
jest.mock("@cocalc/frontend/agents/external-installations", () => ({
  ExternalAgentInstallations: () => <div>External agent installations</div>,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: (store: string, key: string) =>
    store === "customize" && key in mockSiteConnectors
      ? mockSiteConnectors[key]
      : "account",
}));
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openProjectDocs: jest.fn(),
}));

const agent = (name: string, agent_id: string) => ({
  account_id: "account",
  name,
  endpoint: { project_id: "project", agent_id },
  path: "/agents.chat",
  thread_id: "thread",
  project_title: "Research",
  available: true,
  updated_at: "2026-10-03T00:00:00.000Z",
});
const config = (agent_id: string, projects: string[], enabled = true) => ({
  config_id: `config-${agent_id}`,
  account_id: "account",
  agent_id,
  source_project_id: "project",
  scope: {
    version: 1 as const,
    account: [],
    projects: projects.map((project_id) => ({ project_id })),
  },
  revision: 1,
  enabled,
  created_at: new Date(),
  updated_at: new Date(),
});
const network = (title: string, state: "active" | "paused" | "closed") => ({
  agent_network_id: `network-${title}`,
  account_id: "account",
  title,
  state,
  delivery_mode: "queued" as const,
  generation: "g",
  created_by: "account",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  members: [
    {
      kind: "registered" as const,
      member_id: "m1",
      endpoint: { project_id: "project", agent_id: "builder-id" },
      added_at: "2026-10-03T00:00:00.000Z",
    },
    {
      kind: "registered" as const,
      member_id: "m2",
      endpoint: { project_id: "project", agent_id: "gone-id" },
      added_at: "2026-10-03T00:00:00.000Z",
      removed_at: "2026-10-03T00:00:00.000Z",
    },
  ],
});

beforeEach(() => {
  mockSiteConnectors.cli_connector_github_enabled = true;
  mockSiteConnectors.cli_connector_cloudflare_enabled = true;
  jest.clearAllMocks();
  mockApi.listCliConnections.mockResolvedValue([]);
  mockApi.listCliConnectorGrants.mockResolvedValue([]);
  mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
  refreshCliConnectors();
  mockAgents = {
    directory: {
      enabled: true,
      agents: [agent("builder", "builder-id"), agent("writer", "writer-id")],
      controls: { paused: false, generation: 1 },
    },
  };
  mockApi.updateAgentNetwork.mockResolvedValue({});
  mockNetworks = {
    directory: {
      enabled: true,
      networks: [network("Team", "active"), network("Old", "closed")],
      usage: { active_networks: 1, network_limit: 10, member_limit: 10 },
      controls: { paused: false, generation: 1 },
    },
  };
  mockApi.listCocalcConnectorConfigs.mockResolvedValue([
    config("builder-id", ["other", "project"]),
    config("writer-id", [], false),
    // An agent the account can no longer reach is not listed.
    config("unknown-id", ["other"]),
  ]);
  mockApi.getCocalcConnectorConfig.mockImplementation(async ({ agent_id }) =>
    config(agent_id, ["other"]),
  );
});

test("lists agents with CoCalc access and opens their settings", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  const builder = (await screen.findByText("@builder")).closest("tr")!;
  // The agent's own project is always reachable and not counted.
  expect(within(builder).getByText("1 project")).toBeVisible();
  expect(within(builder).getByText("Research")).toBeVisible();
  const writer = screen.getByText("@writer").closest("tr")!;
  expect(within(writer).getByText("Off")).toBeVisible();
  expect(screen.getAllByRole("row")).toHaveLength(3 + 2);
  await user.click(
    screen.getByRole("button", { name: "Manage CoCalc access for @builder" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  await waitFor(() => expect(dialog).toBeVisible());
});

test("says when no agent has CoCalc access, and retries after an error", async () => {
  const user = userEvent.setup();
  mockApi.listCocalcConnectorConfigs.mockResolvedValueOnce([]);
  const view = render(<ConnectionsPage />);
  expect(await screen.findByText("No agent has CoCalc access.")).toBeVisible();
  view.unmount();
  mockApi.listCocalcConnectorConfigs.mockRejectedValueOnce(
    new Error("home bay unavailable"),
  );
  render(<ConnectionsPage />);
  expect(await screen.findByText(/home bay unavailable/)).toBeVisible();
  const calls = mockApi.listCocalcConnectorConfigs.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(mockApi.listCocalcConnectorConfigs.mock.calls.length).toBe(
      calls + 1,
    ),
  );
  expect(await screen.findByText("@builder")).toBeVisible();
});

test("shows open networks with their agents, status and delivery", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  const team = screen.getByText("Team").closest("tr")!;
  // Removed members are not counted.
  expect(within(team).getByText("1")).toBeVisible();
  expect(within(team).getByText("Active")).toBeVisible();
  expect(within(team).getByText("Queued")).toBeVisible();
  expect(screen.queryByText("Old")).not.toBeInTheDocument();
  // The account-wide controls moved here from AI settings.
  expect(
    screen.getByRole("button", { name: "Pause all messaging" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Revoke all networks" }),
  ).toBeVisible();
  expect(screen.getByText("External agent installations")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "AI settings" }));
  expect(mockOpenSettings).toHaveBeenCalledWith({ page: "ai" });
});

test("clicking Active pauses the network", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  await user.click(
    screen.getByRole("button", { name: "Pause the Team network" }),
  );
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_network_id: "network-Team",
        action: "pause",
      }),
    ),
  );
  expect(mockRefreshNetworks).toHaveBeenCalled();
});

test("switching to live delivery asks first", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  await user.click(
    screen.getByRole("button", {
      name: "Use live delivery in the Team network",
    }),
  );
  expect(mockApi.updateAgentNetwork).not.toHaveBeenCalled();
  await user.click(
    await screen.findByRole("button", { name: "Enable live delivery" }),
  );
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set-delivery",
        delivery_mode: "live",
      }),
    ),
  );
});

test("deleting a network asks first, then closes it", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  await user.click(
    screen.getByRole("button", { name: "Delete the Team network" }),
  );
  expect(mockApi.updateAgentNetwork).not.toHaveBeenCalled();
  await user.click(
    await screen.findByRole("button", { name: "Delete network" }),
  );
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ action: "close" }),
    ),
  );
});

test("when all messaging is paused, every network says so", () => {
  mockNetworks.directory!.controls.paused = true;
  mockAgents.directory!.controls!.paused = true;
  render(<ConnectionsPage />);
  expect(screen.getByText("All agent messaging is paused")).toBeVisible();
  const team = screen.getByText("Team").closest("tr")!;
  expect(within(team).getByText("Paused (all messaging)")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Resume all messaging" }),
  ).toBeVisible();
});

test("the Connectors page is listed in settings, except in Lite", () => {
  const pages = (isLite: boolean) =>
    getVisibleSettingsNavigation({
      isLite,
      isCommercial: true,
      stripeEnabled: true,
      zendesk: true,
      isAdmin: false,
    } as any).flatMap((node) =>
      node.type === "group" ? node.pages.map(({ page }) => page) : [node.page],
    );
  expect(pages(false)).toContain("connectors");
  expect(pages(true)).not.toContain("connections");
  expect(pages(true)).not.toContain("connectors");
});

test("resuming all messaging goes through fresh authentication", async () => {
  // The hub requires fresh auth to resume; without the wrapper the user only
  // saw "fresh auth is required".
  mockNetworks.directory!.controls.paused = true;
  mockAgents.directory!.controls!.paused = true;
  mockApi.setPersonalMessagingState.mockResolvedValue({});
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  mockFreshAuth.mockClear();
  await user.click(
    screen.getByRole("button", { name: "Resume all messaging" }),
  );
  await waitFor(() =>
    expect(mockApi.setPersonalMessagingState).toHaveBeenCalledWith({
      action: "resume",
    }),
  );
  expect(mockFreshAuth).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Agent messaging resumed.")).toBeVisible();
});

test("network changes go through fresh authentication", async () => {
  const user = userEvent.setup();
  render(<ConnectionsPage />);
  mockFreshAuth.mockClear();
  await user.click(
    screen.getByRole("button", { name: "Pause the Team network" }),
  );
  await waitFor(() => expect(mockApi.updateAgentNetwork).toHaveBeenCalled());
  expect(mockFreshAuth).toHaveBeenCalledTimes(1);
});

test("shows no GitHub or Cloudflare sections until the site sets them up", async () => {
  mockSiteConnectors.cli_connector_github_enabled = false;
  mockSiteConnectors.cli_connector_cloudflare_enabled = false;
  render(<ConnectionsPage />);
  expect(await screen.findByText("Agent Networks")).toBeVisible();
  expect(screen.queryByText("GitHub")).toBeNull();
  expect(screen.queryByText("Cloudflare")).toBeNull();
  expect(mockApi.listCliConnections).not.toHaveBeenCalled();
});
