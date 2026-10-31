import React, { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SetConnectorsModal,
  applyConnectorChanges,
  plannedConnectorChanges,
} from "./cli-connectors-bulk";
import { refreshCliConnectors } from "./cli-connectors-store";

const mockApi = {
  listCliConnections: jest.fn(),
  listCliConnectorGrants: jest.fn(),
  getCliConnectorSetup: jest.fn(),
  saveCliConnectorGrant: jest.fn(),
};
jest.mock("./api", () => ({ personalAgentApi: () => mockApi }));
// The site has GitHub set up.
jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: (store: string, key: string) =>
      store === "customize" && key === "cli_connector_github_enabled"
        ? true
        : store === "customize" && key === "cli_connector_cloudflare_enabled"
          ? false
          : actual.useTypedRedux(store, key),
  };
});
jest.mock("@cocalc/frontend/project/use-project-run-quota", () => ({
  useProjectRunQuota: () => ({ runQuota: { network: true } }),
}));
const mockFreshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  isFreshAuthRequiredError: (err: any) => err?.code === "fresh_auth_required",
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action) => mockFreshAuth(action),
    freshAuthModalProps: {},
  }),
}));

const agent = (name: string) =>
  ({
    name,
    endpoint: { project_id: "project", agent_id: `${name}-id` },
  }) as any;
const connection = (id: string, description: string) => ({
  connection_id: id,
  connector: "github" as const,
  description,
  created: new Date(),
  last_used: null,
});
const grant = (name: string, connection_id: string, enabled = true) => ({
  grant_id: `grant-${name}`,
  account_id: "account",
  agent_id: `${name}-id`,
  source_project_id: "project",
  connector: "github" as const,
  connection_id,
  scope: {},
  revision: 5,
  enabled,
  created_at: new Date(),
  updated_at: new Date(),
});
const SETUP = {
  github: { available: true },
  cloudflare: { available: false },
};
const data = {
  connections: [
    connection("personal", "@williamstein"),
    connection("agents", "@wstein-agents"),
  ],
  grants: [
    grant("a", "personal"),
    grant("b", "agents"),
    grant("c", "personal", false),
  ],
  setup: SETUP,
} as any;
const agents = [agent("a"), agent("b"), agent("c"), agent("d")];

describe("planning", () => {
  it("uses one account for every agent not already on it", () => {
    const changes = plannedConnectorChanges(data, agents, "github", "agents");
    expect(
      changes.map((c) => [c.agent.name, c.connection_id, c.expected_revision]),
    ).toEqual([
      ["a", "agents", 5],
      ["c", "agents", 5],
      ["d", "agents", undefined],
    ]);
    expect(changes.every((c) => c.enabled)).toBe(true);
  });

  it("turns off only agents that have it on", () => {
    const changes = plannedConnectorChanges(data, agents, "github", "off");
    expect(changes.map((c) => c.agent.name)).toEqual(["a", "b"]);
    expect(changes.every((c) => !c.enabled && c.expected_revision === 5)).toBe(
      true,
    );
    expect(plannedConnectorChanges(data, agents, "github", "keep")).toEqual([]);
  });
});

describe("applying", () => {
  it("saves each agent and reports the ones that failed", async () => {
    const save = jest.fn(async (opts: any) => {
      if (opts.agent_id === "c-id")
        throw new Error("connection is unavailable");
      return {} as any;
    });
    const changes = plannedConnectorChanges(data, agents, "github", "agents");
    const failures = await applyConnectorChanges("github", changes, save);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledWith({
      agent_id: "a-id",
      source_project_id: "project",
      connector: "github",
      connection_id: "agents",
      enabled: true,
      expected_revision: 5,
    });
    expect(failures).toEqual(["@c: Error: connection is unavailable"]);
  });

  it("rethrows a fresh-auth requirement instead of reporting it", async () => {
    const save = jest.fn(async () => {
      throw Object.assign(new Error("fresh auth"), {
        code: "fresh_auth_required",
      });
    });
    const changes = plannedConnectorChanges(data, agents, "github", "agents");
    await expect(
      applyConnectorChanges("github", changes, save),
    ).rejects.toThrow("fresh auth");
  });
});

describe("Set connectors dialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.listCliConnections.mockResolvedValue(data.connections);
    mockApi.listCliConnectorGrants.mockResolvedValue(data.grants);
    mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
    mockApi.saveCliConnectorGrant.mockResolvedValue({});
    refreshCliConnectors();
  });

  it("puts the selected agents on one GitHub account, through fresh auth", async () => {
    const onClose = jest.fn();
    render(
      <SetConnectorsModal
        open
        agents={agents}
        connectors={["github"]}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Set connectors for 4 agents",
    });
    const apply = within(dialog).getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    // Once the connections are loaded.
    await waitFor(() =>
      expect(dialog.querySelector(".ant-select-loading")).toBeNull(),
    );
    await userEvent.click(
      within(dialog).getByLabelText("GitHub for selected agents"),
    );
    await userEvent.click(
      (await screen.findAllByText("Use @wstein-agents")).at(-1)!,
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Changes 3 agents.",
    );
    await userEvent.click(apply);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockFreshAuth).toHaveBeenCalledTimes(1);
    expect(mockApi.saveCliConnectorGrant).toHaveBeenCalledTimes(3);
    expect(
      mockApi.saveCliConnectorGrant.mock.calls.map((c) => c[0].agent_id).sort(),
    ).toEqual(["a-id", "c-id", "d-id"]);
  });

  it("keeps the dialog open and names the agents that were not changed", async () => {
    mockApi.saveCliConnectorGrant.mockImplementation(async (opts: any) => {
      if (opts.agent_id === "a-id")
        throw new Error("connector settings changed; reload and try again");
      return {};
    });
    const onClose = jest.fn();
    render(
      <SetConnectorsModal
        open
        agents={agents}
        connectors={["github"]}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    // Once the connections are loaded.
    await waitFor(() =>
      expect(dialog.querySelector(".ant-select-loading")).toBeNull(),
    );
    await userEvent.click(
      within(dialog).getByLabelText("GitHub for selected agents"),
    );
    await userEvent.click(
      (await screen.findAllByText("Turn GitHub off")).at(-1)!,
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Apply" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Not changed for 1 agent");
    expect(alert).toHaveTextContent("@a: Error: connector settings changed");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Set connectors dialog by keyboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.listCliConnections.mockResolvedValue(data.connections);
    mockApi.listCliConnectorGrants.mockResolvedValue(data.grants);
    mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
    mockApi.saveCliConnectorGrant.mockResolvedValue({});
    refreshCliConnectors();
  });

  // As the Agents page uses it: mounted only while open.
  function Page() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Set connectors…</button>
        {open && (
          <SetConnectorsModal
            open
            agents={agents}
            connectors={["github"]}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  it("opens from its button, closes with Escape, and gives the focus back", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole("button", { name: "Set connectors…" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.saveCliConnectorGrant).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("chooses an account and applies with the keys only", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole("button", { name: "Set connectors…" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelector(".ant-select-loading")).toBeNull(),
    );
    const select = within(dialog).getByRole("combobox", {
      name: "GitHub for selected agents",
    });
    select.focus();
    // Options: Leave unchanged, Use @williamstein, Use @wstein-agents, Off.
    // Enter opens the list; antd's list reads keyCode, which user-event does
    // not set in jsdom, so its arrows and Enter are sent with it.
    await user.keyboard("{Enter}");
    const key = (key: string, keyCode: number) =>
      fireEvent.keyDown(select, { key, code: key, keyCode, which: keyCode });
    key("ArrowDown", 40);
    key("ArrowDown", 40);
    key("Enter", 13);
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Changes 3 agents.",
      ),
    );
    const apply = within(dialog).getByRole("button", { name: "Apply" });
    apply.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.saveCliConnectorGrant).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
