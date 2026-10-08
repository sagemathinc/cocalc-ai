import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentNetworkDirectory,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import {
  agentNetworksSummary,
  cocalcAccessSummary,
  ComposerConnectors,
  supportsCocalcConnector,
} from "./composer-connectors";
import { AgentFileAttachment } from "../chat/agent-file-attachment";
import { refreshCliConnectors } from "./cli-connectors";

// rc-util's constant test ID aliases dropdown and modal Escape registrations.
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
jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: (store: string, key: string) =>
      store === "customize" && key in mockSiteConnectors
        ? mockSiteConnectors[key]
        : actual.useTypedRedux(store, key),
  };
});
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const generated = require("react").useId();
    return id ?? generated;
  },
}));

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
  getCocalcConnectorConfig: jest.fn(),
  saveCocalcConnectorConfig: jest.fn(),
  removeCocalcConnectorConfig: jest.fn(),
  listAgentNetworkActivity: jest.fn(),
};
const mockRefresh = jest.fn();
let mockDirectory: AgentNetworkDirectory | undefined;
let mockError: string | undefined;
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  useAgentNetworks: () => ({ directory: mockDirectory, error: mockError }),
  refreshAgentNetworks: () => mockRefresh(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (action) => {
      await action();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/components/api-key-scope-editor", () => ({
  EMPTY_API_KEY_SCOPE: { version: 1, account: [], projects: [] },
  ApiKeyScopeEditor: () => null,
}));
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openProjectDocs: jest.fn(),
}));

const agent: NamedAgent = {
  account_id: "account",
  name: "builder",
  endpoint: { project_id: "project", agent_id: "builder-id" },
  path: "/agents.chat",
  thread_id: "thread",
  available: true,
  updated_at: "2026-09-28T00:00:00.000Z",
};
const config = {
  config_id: "config-id",
  enabled: true,
  revision: 4,
  scope: { version: 1, account: [], projects: [] },
};

function Controls({
  value = agent,
  supportsCocalcAccess = true,
}: {
  value?: NamedAgent | null;
  supportsCocalcAccess?: boolean;
}) {
  return (
    <ComposerConnectors
      agent={value ?? undefined}
      supportsCocalcAccess={supportsCocalcAccess}
    >
      {(extraMenuItems) => (
        <AgentFileAttachment
          projectId="project"
          onInsert={jest.fn()}
          onSetGoal={jest.fn()}
          extraMenuItems={extraMenuItems}
        />
      )}
    </ComposerConnectors>
  );
}

const chipName = /^Connectors for @builder/;

// Opens a connector's editor from the connectors chip, as a keyboard user.
async function openFromChip(
  user: ReturnType<typeof userEvent.setup>,
  item: RegExp,
) {
  const chip = await screen.findByRole("button", { name: chipName });
  chip.focus();
  await user.keyboard("{Enter}");
  const menuItem = await screen.findByRole("menuitem", { name: item });
  menuItem.focus();
  // rc-menu uses KeyboardEvent.which; user-event does not populate it.
  fireEvent.keyDown(menuItem, { key: "Enter", keyCode: 13, which: 13 });
  return chip;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSiteConnectors.cli_connector_github_enabled = true;
  mockSiteConnectors.cli_connector_cloudflare_enabled = true;
  mockRunQuota = { network: true };
  mockApi.listCliConnections.mockResolvedValue([]);
  mockApi.listCliConnectorGrants.mockResolvedValue([]);
  mockApi.getCliConnectorSetup.mockResolvedValue(SETUP);
  refreshCliConnectors();
  mockError = undefined;
  mockDirectory = {
    enabled: true,
    networks: [],
    usage: { active_networks: 0, network_limit: 10, member_limit: 10 },
    controls: { paused: false, generation: 1 },
  };
  mockApi.getCocalcConnectorConfig.mockResolvedValue(null);
  mockApi.saveCocalcConnectorConfig.mockImplementation(async (opts) => ({
    ...opts,
    revision: 5,
  }));
  mockApi.listAgentNetworkActivity.mockResolvedValue([]);
  mockApi.removeCocalcConnectorConfig.mockResolvedValue(undefined);
});

test.each(["CoCalc access", "Agent Networks"])(
  "+ menu opens %s with keyboard and restores focus on Escape",
  async (label) => {
    const user = userEvent.setup();
    render(<Controls />);
    const plus = screen.getByRole("button", { name: "Add files and more" });
    plus.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "Upload files" }),
      ).toBeVisible(),
    );
    expect(
      screen.getByRole("menuitem", { name: "Choose project files" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Set goal" })).toBeVisible();
    // What affects this message is labeled apart from the agent's access.
    expect(screen.getByText("Attach")).toBeVisible();
    expect(screen.getByText("Connectors for @builder")).toBeVisible();
    const item = screen.getByRole("menuitem", {
      name: new RegExp(`^${label}`),
    });
    const menu = screen.getByRole("menu");
    item.focus();
    // rc-menu uses KeyboardEvent.which; user-event does not populate it.
    fireEvent.keyDown(item, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    });
    const dialog = await screen.findByRole("dialog", {
      name:
        label === "CoCalc access"
          ? "CoCalc access for @builder"
          : "Network tags for @builder",
    });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    await waitFor(() => expect(menu).not.toBeVisible());
    within(dialog)
      .getAllByRole("button", { name: "Close", exact: true })[0]
      .focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeVisible());
    await waitFor(() => expect(plus).toHaveFocus());
    expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
  },
);

test("the connectors chip opens CoCalc access and reflects saved disable", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValue(config);
  const user = userEvent.setup();
  render(<Controls />);
  expect(
    await screen.findByRole("button", {
      name: "Connectors for @builder: CoCalc access On",
    }),
  ).toHaveTextContent("1");
  const chip = await openFromChip(user, /^CoCalc access/);
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  await waitFor(() =>
    expect(within(dialog).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    ),
  );
  await user.click(within(dialog).getByRole("switch"));
  await user.click(within(dialog).getByRole("button", { name: "Save access" }));
  expect(
    await screen.findByRole("button", {
      name: "Connectors for @builder: CoCalc access Off",
    }),
  ).toBeVisible();
  await waitFor(() => expect(chip).toHaveFocus());
  expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: false,
      expected_revision: 4,
      agent_id: agent.endpoint.agent_id,
    }),
  );
});

async function plusMenuItems(user: ReturnType<typeof userEvent.setup>) {
  const plus = screen.getByRole("button", { name: "Add files and more" });
  plus.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: /^Agent Networks/ }),
    ).toBeVisible(),
  );
  return screen.getAllByRole("menuitem").map((item) => item.textContent);
}

test("connectors the site has not set up are not shown or loaded", async () => {
  mockSiteConnectors.cli_connector_github_enabled = false;
  mockSiteConnectors.cli_connector_cloudflare_enabled = false;
  const user = userEvent.setup();
  render(<Controls />);
  const items = await plusMenuItems(user);
  expect(items.some((text) => /GitHub|Cloudflare/.test(`${text}`))).toBe(false);
  expect(mockApi.listCliConnections).not.toHaveBeenCalled();
  expect(mockApi.listCliConnectorGrants).not.toHaveBeenCalled();
  expect(mockApi.getCliConnectorSetup).not.toHaveBeenCalled();
});

test("only the connectors the site set up are shown", async () => {
  mockSiteConnectors.cli_connector_cloudflare_enabled = false;
  const user = userEvent.setup();
  render(<Controls />);
  const items = await plusMenuItems(user);
  expect(items.some((text) => /^GitHub/.test(`${text}`))).toBe(true);
  expect(items.some((text) => /^Cloudflare/.test(`${text}`))).toBe(false);
});

test("a project without internet access says so", async () => {
  mockRunQuota = { network: false };
  const user = userEvent.setup();
  render(<Controls />);
  await plusMenuItems(user);
  expect(
    screen.getByRole("menuitem", { name: /^GitHub.*Needs internet access/ }),
  ).toBeVisible();
});

test("GitHub on for the agent shows in the chip and opens its dialog", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValue(null);
  mockApi.listCliConnections.mockResolvedValue([
    {
      connection_id: "conn-1",
      connector: "github",
      description: "@octo",
      created: new Date(),
      last_used: null,
    },
  ]);
  mockApi.listCliConnectorGrants.mockResolvedValue([
    {
      grant_id: "grant-1",
      account_id: "account",
      agent_id: agent.endpoint.agent_id,
      source_project_id: agent.endpoint.project_id,
      connector: "github",
      connection_id: "conn-1",
      scope: {},
      revision: 1,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    },
  ]);
  refreshCliConnectors();
  const user = userEvent.setup();
  render(<Controls />);
  expect(
    await screen.findByRole("button", {
      name: "Connectors for @builder: GitHub @octo",
    }),
  ).toHaveTextContent("1");
  await openFromChip(user, /^GitHub/);
  const dialog = await screen.findByRole("dialog", {
    name: "GitHub for @builder",
  });
  await waitFor(() =>
    expect(within(dialog).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    ),
  );
  expect(within(dialog).getByRole("radio", { name: "@octo" })).toBeChecked();
});

test("network icon tracks assigned tags, preserves details, and disappears after removal", async () => {
  mockDirectory!.networks = [
    {
      agent_network_id: "network",
      account_id: "account",
      title: "Team",
      state: "active",
      delivery_mode: "live",
      generation: "g",
      created_by: "account",
      created_at: agent.updated_at,
      updated_at: agent.updated_at,
      members: [
        {
          kind: "registered",
          member_id: "m",
          endpoint: agent.endpoint,
          added_at: agent.updated_at,
        },
      ],
    },
  ];
  const user = userEvent.setup();
  const view = render(<Controls />);
  expect(
    screen.getByRole("button", {
      name: "Connectors for @builder: Agent Networks Team",
    }),
  ).toBeVisible();
  await openFromChip(user, /^Agent Networks/);
  const dialog = await screen.findByRole("dialog", {
    name: "Network tags (1) for @builder",
  });
  await waitFor(() =>
    expect(
      within(dialog).getByText(
        "Network tags are permissions, not just labels.",
      ),
    ).toBeVisible(),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Configure Team network tag" }),
  );
  await waitFor(() =>
    expect(mockApi.listAgentNetworkActivity).toHaveBeenCalledWith(
      expect.objectContaining({ agent_network_id: "network" }),
    ),
  );
  view.unmount();
  mockDirectory!.networks[0].members[0].removed_at = agent.updated_at;
  render(<Controls />);
  expect(
    screen.queryByRole("button", { name: chipName }),
  ).not.toBeInTheDocument();
});

test.each([true, false])(
  "removal clears %s enabled connector and restores keyboard focus to +",
  async (enabled) => {
    mockApi.getCocalcConnectorConfig.mockResolvedValue({ ...config, enabled });
    const user = userEvent.setup();
    render(<Controls />);
    await openFromChip(user, /^CoCalc access/);
    const remove = await screen.findByRole("button", {
      name: "Remove connector",
    });
    await waitFor(() => expect(remove).toBeEnabled());
    remove.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Remove CoCalc connector?" }),
      ).toBeVisible(),
    );
    expect(mockApi.removeCocalcConnectorConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("switch", { name: "Enable CoCalc access" }),
    ).toHaveAttribute("aria-checked", `${enabled}`);
    await user.click(screen.getByRole("button", { name: "Remove connector" }));
    screen.getByRole("button", { name: "Remove connector" }).focus();
    mockApi.getCocalcConnectorConfig.mockResolvedValue(null);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: chipName }),
      ).not.toBeInTheDocument(),
    );
    const plus = screen.getByRole("button", { name: "Add files and more" });
    await waitFor(() => expect(plus).toHaveFocus());
    expect(mockApi.removeCocalcConnectorConfig).toHaveBeenCalledTimes(1);
    expect(mockApi.removeCocalcConnectorConfig).toHaveBeenCalledWith({
      agent_id: agent.endpoint.agent_id,
      source_project_id: agent.endpoint.project_id,
      expected_config_id: config.config_id,
      expected_revision: config.revision,
    });
    expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
    await user.click(plus);
    await user.click(
      screen.getByRole("menuitem", { name: "CoCalc access Off" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable CoCalc access" }),
      ).toHaveAttribute("aria-checked", "false"),
    );
    expect(
      screen.queryByRole("button", { name: "Remove connector" }),
    ).not.toBeInTheDocument();
  },
);

test("failed removal retains the connector and exposes the error", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValue(config);
  mockApi.removeCocalcConnectorConfig.mockRejectedValueOnce(
    new Error("revocation unavailable"),
  );
  const user = userEvent.setup();
  render(<Controls />);
  const chip = await openFromChip(user, /^CoCalc access/);
  const remove = await screen.findByRole("button", {
    name: "Remove connector",
  });
  await waitFor(() => expect(remove).toBeEnabled());
  await user.click(remove);
  await user.click(screen.getByRole("button", { name: "Remove connector" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "revocation unavailable",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(chip).toHaveFocus());
});

test("no config means no connectors chip, and unregistered chats keep only the original menu", async () => {
  const user = userEvent.setup();
  const view = render(<Controls />);
  await waitFor(() =>
    expect(mockApi.getCocalcConnectorConfig).toHaveBeenCalled(),
  );
  expect(
    screen.queryByRole("button", { name: chipName }),
  ).not.toBeInTheDocument();
  view.rerender(<Controls value={null} />);
  await user.click(screen.getByRole("button", { name: "Add files and more" }));
  expect(
    screen.queryByRole("menuitem", { name: /^Agent Networks/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: /^CoCalc access/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Attach")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "Upload files" }),
    ).toBeVisible(),
  );
});

test("network loading failures remain reachable from + with retry", async () => {
  mockDirectory = undefined;
  mockError = "Service unavailable";
  const user = userEvent.setup();
  render(<Controls />);
  await user.click(screen.getByRole("button", { name: "Add files and more" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Agent Networks Unable to load" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Service unavailable",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("unsupported harness keeps networks usable without offering CoCalc access", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValue(config);
  const user = userEvent.setup();
  const view = render(<Controls supportsCocalcAccess={false} />);
  const plus = screen.getByRole("button", { name: "Add files and more" });
  plus.focus();
  await user.keyboard("{Enter}");
  const unavailable = await screen.findByRole("menuitem", {
    name: "CoCalc access Codex and Claude only",
  });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  expect(mockApi.getCocalcConnectorConfig).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: chipName })).toBeNull();

  const networks = screen.getByRole("menuitem", { name: /^Agent Networks/ });
  networks.focus();
  fireEvent.keyDown(networks, { key: "Enter", keyCode: 13, which: 13 });
  const dialog = await screen.findByRole("dialog", {
    name: "Network tags for @builder",
  });
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  within(dialog)
    .getAllByRole("button", { name: "Close", exact: true })[0]
    .focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(plus).toHaveFocus());

  // A runtime switch must neither rewrite nor remove existing saved grants.
  view.rerender(<Controls supportsCocalcAccess />);
  expect(
    await screen.findByRole("button", {
      name: "Connectors for @builder: CoCalc access On",
    }),
  ).toBeVisible();
  view.rerender(<Controls supportsCocalcAccess={false} />);
  expect(screen.queryByRole("button", { name: chipName })).toBeNull();
  expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
  expect(mockApi.removeCocalcConnectorConfig).not.toHaveBeenCalled();
});

test("the CoCalc connector is offered for Codex and Claude Code threads only", () => {
  expect(supportsCocalcConnector(undefined)).toBe(false);
  expect(supportsCocalcConnector({})).toBe(true);
  expect(
    supportsCocalcConnector({
      agent_runtime: {
        kind: "acp",
        profile: { version: 2, id: "claude-code" },
      },
    }),
  ).toBe(true);
  expect(
    supportsCocalcConnector({
      agent_runtime: { kind: "acp", profile: { version: 1, id: "custom" } },
    }),
  ).toBe(false);
});

test("status summaries say what each connector reaches", () => {
  const scope = (over = {}) => ({
    ...config,
    scope: { version: 1 as const, account: [], projects: [], ...over },
  });
  expect(cocalcAccessSummary(null, "project")).toBe("Off");
  expect(cocalcAccessSummary({ ...config, enabled: false }, "project")).toBe(
    "Off",
  );
  expect(cocalcAccessSummary(scope(), "project")).toBe("On");
  // The agent's own project is always reachable and not counted.
  expect(
    cocalcAccessSummary(
      scope({
        projects: [{ project_id: "project" }, { project_id: "a" }],
      }) as any,
      "project",
    ),
  ).toBe("1 project");
  expect(
    cocalcAccessSummary(
      scope({ all_projects: {}, account: ["x"] }) as any,
      "project",
    ),
  ).toBe("all projects, account");
  expect(agentNetworksSummary([], false)).toBe("None");
  expect(agentNetworksSummary(["Team"], false)).toBe("Team");
  expect(agentNetworksSummary(["A", "B", "C", "D"], true)).toBe(
    "Paused: A, B +2",
  );
});
