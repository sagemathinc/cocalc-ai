import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
import {
  CliConnectorAgentModal,
  CliConnectorSection,
  refreshCliConnectors,
} from "./cli-connectors";

const mockApi = {
  listCliConnections: jest.fn(),
  listCliConnectorGrants: jest.fn(),
  connectCliToken: jest.fn(),
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

  it("connects a pasted token through fresh auth and reloads", async () => {
    mockApi.listCliConnections.mockResolvedValueOnce([]);
    mockApi.listCliConnectorGrants.mockResolvedValueOnce([]);
    refreshCliConnectors();
    mockApi.connectCliToken.mockResolvedValue(connection("conn-2", "@new"));
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
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText("GitHub token"),
      "  github_pat_x  ",
    );
    await userEvent.click(connect);
    await waitFor(() =>
      expect(mockApi.connectCliToken).toHaveBeenCalledWith({
        connector: "github",
        token: "github_pat_x",
      }),
    );
    expect(mockFreshAuth).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockApi.listCliConnections).toHaveBeenCalledTimes(2),
    );
  });

  it("shows why a token was refused", async () => {
    mockApi.connectCliToken.mockRejectedValue(
      new Error("GitHub did not accept the token"),
    );
    render(<CliConnectorSection connector="github" />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Connect another GitHub account",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Connect GitHub",
    });
    await userEvent.type(within(dialog).getByLabelText("GitHub token"), "bad");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Connect" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "GitHub did not accept the token",
    );
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
