import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
import {
  CliConnectorAgentModal,
  CliConnectorSection,
  refreshCliConnectors,
} from "./cli-connectors";

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
};
let mockAgents: { directory?: NamedAgentDirectory; error?: string };
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  useNamedAgents: () => mockAgents,
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
const connection = (connection_id: string, description: string) => ({
  connection_id,
  connector: "github" as const,
  description,
  created: new Date(),
  last_used: null,
});
const grant = (agent_id: string, connection_id: string, enabled = true) => ({
  grant_id: `grant-${agent_id}`,
  account_id: "account",
  agent_id,
  source_project_id: "project",
  connector: "github" as const,
  connection_id,
  scope: {},
  revision: 3,
  enabled,
  created_at: new Date(),
  updated_at: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAgents = {
    directory: {
      enabled: true,
      agents: [agent("builder", "builder-id"), agent("writer", "writer-id")],
      controls: { paused: false, generation: 1 },
    } as any,
  };
  mockApi.listCliConnections.mockResolvedValue([
    connection("conn-1", "@octo"),
    {
      ...connection("conn-cf", "API token"),
      connector: "cloudflare",
    },
  ]);
  mockApi.listCliConnectorGrants.mockResolvedValue([
    grant("builder-id", "conn-1"),
    grant("writer-id", "conn-1", false),
  ]);
  mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
  refreshCliConnectors();
});

describe("Settings > Connectors section", () => {
  it("lists this connector's accounts and the agents using each", async () => {
    render(<CliConnectorSection connector="github" />);
    const [table] = await screen.findAllByRole("table");
    const row = within(table).getByRole("row", { name: /@octo/ });
    // Only agents with GitHub on are listed; other connectors' accounts are not.
    expect(row).toHaveTextContent("@builder");
    expect(row).not.toHaveTextContent("@writer");
    expect(screen.queryByText("API token")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Manage GitHub for @builder" }),
    ).toBeVisible();
  });

  const signIn = {
    login_id: "login-1",
    connector: "github",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    interval: 0.01,
    expires_at: Date.now() + 600_000,
  };

  it("signs in with a code approved on GitHub, through fresh auth", async () => {
    mockApi.listCliConnections.mockResolvedValueOnce([]);
    mockApi.listCliConnectorGrants.mockResolvedValueOnce([]);
    refreshCliConnectors();
    mockApi.startCliConnectorSignIn.mockResolvedValue(signIn);
    // The second poll waits until the test approves the sign-in.
    let approve!: (value: unknown) => void;
    mockApi.pollCliConnectorSignIn
      .mockResolvedValueOnce({ status: "pending" })
      .mockReturnValueOnce(new Promise((resolve) => (approve = resolve)));
    render(<CliConnectorSection connector="github" />);
    expect(
      await screen.findByText("No GitHub account is connected."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect a GitHub account" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Connect GitHub",
    });
    await within(dialog).findByText("ABCD-1234");
    expect(
      within(dialog).getByRole("link", { name: "Open GitHub" }),
    ).toHaveAttribute("href", "https://github.com/login/device");
    expect(
      within(dialog).getByRole("link", { name: "choose repositories" }),
    ).toHaveAttribute("href", "https://github.com/apps/cocalc-test");
    expect(mockApi.startCliConnectorSignIn).toHaveBeenCalledWith({
      connector: "github",
    });
    expect(mockFreshAuth).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockApi.pollCliConnectorSignIn).toHaveBeenCalledTimes(2),
    );
    expect(mockApi.pollCliConnectorSignIn).toHaveBeenCalledWith({
      login_id: "login-1",
    });
    expect(within(dialog).getByText("ABCD-1234")).toBeVisible();
    approve({ status: "connected", connection: connection("conn-2", "@new") });
    await waitFor(() => expect(dialog).not.toBeVisible());
    // The new account is loaded.
    await waitFor(() =>
      expect(mockApi.listCliConnections).toHaveBeenCalledTimes(2),
    );
  });

  it("explains a declined sign-in and can try again", async () => {
    mockApi.startCliConnectorSignIn.mockResolvedValue(signIn);
    mockApi.pollCliConnectorSignIn.mockResolvedValue({ status: "denied" });
    render(<CliConnectorSection connector="github" />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Connect another GitHub account",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Connect GitHub",
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The sign-in was declined on GitHub.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(mockApi.startCliConnectorSignIn).toHaveBeenCalledTimes(2),
    );
  });

  it("says when the site has not set the connector up", async () => {
    mockApi.listCliConnections.mockResolvedValue([]);
    refreshCliConnectors();
    render(<CliConnectorSection connector="cloudflare" />);
    expect(
      await screen.findByText(/Cloudflare is not set up on this site yet/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Connect .* Cloudflare account/ }),
    ).toBeNull();
  });

  it("marks a connection that needs a new sign-in", async () => {
    mockApi.listCliConnections.mockResolvedValue([
      { ...connection("conn-1", "@octo"), needs_reconnect: true },
    ]);
    refreshCliConnectors();
    render(<CliConnectorSection connector="github" />);
    expect(await screen.findByText("Sign in again")).toBeVisible();
  });

  it("disconnects after confirming, naming the agents that lose it", async () => {
    mockApi.disconnectCliConnection.mockResolvedValue(undefined);
    render(<CliConnectorSection connector="github" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Disconnect @octo" }),
    );
    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("1 agent uses it");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(mockApi.disconnectCliConnection).toHaveBeenCalledWith({
        connection_id: "conn-1",
      }),
    );
  });
});

describe("per-agent dialog", () => {
  it("turns GitHub on with the chosen account", async () => {
    mockApi.saveCliConnectorGrant.mockResolvedValue(
      grant("writer-id", "conn-1"),
    );
    const onClose = jest.fn();
    render(
      <CliConnectorAgentModal
        agent={agent("writer", "writer-id") as any}
        connector="github"
        open
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "GitHub for @writer",
    });
    const save = within(dialog).getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect(within(dialog).getByRole("switch")).not.toBeChecked(),
    );
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("switch"));
    expect(within(dialog).getByRole("radio", { name: "@octo" })).toBeChecked();
    await userEvent.click(save);
    await waitFor(() =>
      expect(mockApi.saveCliConnectorGrant).toHaveBeenCalledWith({
        agent_id: "writer-id",
        source_project_id: "project",
        connector: "github",
        connection_id: "conn-1",
        enabled: true,
        expected_revision: 3,
      }),
    );
    expect(mockFreshAuth).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("turns GitHub off", async () => {
    mockApi.saveCliConnectorGrant.mockResolvedValue(
      grant("builder-id", "conn-1", false),
    );
    render(
      <CliConnectorAgentModal
        agent={agent("builder", "builder-id") as any}
        connector="github"
        open
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("switch")).toBeChecked(),
    );
    await userEvent.click(within(dialog).getByRole("switch"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.saveCliConnectorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, agent_id: "builder-id" }),
      ),
    );
  });

  it("cannot turn on without a connected account", async () => {
    mockApi.listCliConnections.mockResolvedValue([]);
    mockApi.listCliConnectorGrants.mockResolvedValue([]);
    mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
    refreshCliConnectors();
    render(
      <CliConnectorAgentModal
        agent={agent("writer", "writer-id") as any}
        connector="github"
        open
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("switch"));
    expect(dialog).toHaveTextContent("Connect a GitHub account first.");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
