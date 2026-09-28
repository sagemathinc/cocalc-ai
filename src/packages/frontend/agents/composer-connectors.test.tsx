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
import { ComposerConnectors } from "./composer-connectors";
import { AgentFileAttachment } from "../chat/agent-file-attachment";

// rc-util's constant test ID aliases dropdown and modal Escape registrations.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const generated = require("react").useId();
    return id ?? generated;
  },
}));

const mockApi = {
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
  extraActions,
}: {
  value?: NamedAgent | null;
  supportsCocalcAccess?: boolean;
  extraActions?: React.ComponentProps<
    typeof AgentFileAttachment
  >["extraActions"];
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
          extraActions={extraActions}
        />
      )}
    </ComposerConnectors>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
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

test("reference actions and connector entries coexist in the keyboard + menu", async () => {
  const onReference = jest.fn();
  const user = userEvent.setup();
  render(
    <Controls
      extraActions={[
        {
          key: "reference",
          label: "Link to CoCalc content",
          onClick: onReference,
        },
      ]}
    />,
  );
  const plus = screen.getByRole("button", { name: "Add files and more" });
  plus.focus();
  await user.keyboard("{Enter}");
  const reference = await screen.findByRole("menuitem", {
    name: "Link to CoCalc content",
  });
  await waitFor(() => expect(reference).toBeVisible());
  expect(
    screen.getByRole("menuitem", { name: "CoCalc", exact: true }),
  ).toBeVisible();
  expect(
    screen.getByRole("menuitem", { name: "Agent Networks" }),
  ).toBeVisible();
  reference.focus();
  fireEvent.keyDown(reference, { key: "Enter", keyCode: 13, which: 13 });
  expect(onReference).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(plus).toHaveFocus());
  expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
});

test.each(["CoCalc", "Agent Networks"])(
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
    const item = screen.getByRole("menuitem", { name: label });
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
        label === "CoCalc"
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

test("configured CoCalc icon opens its editor and reflects saved disable", async () => {
  mockApi.getCocalcConnectorConfig.mockResolvedValue(config);
  const user = userEvent.setup();
  render(<Controls />);
  const icon = await screen.findByRole("button", { name: "CoCalc connector" });
  icon.focus();
  await user.keyboard("{Enter}");
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
    await screen.findByRole("button", { name: "CoCalc connector (disabled)" }),
  ).toBeVisible();
  await waitFor(() => expect(icon).toHaveFocus());
  expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: false,
      expected_revision: 4,
      agent_id: agent.endpoint.agent_id,
    }),
  );
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
  const icon = screen.getByRole("button", {
    name: "Agent Networks connector (1 tag)",
  });
  icon.focus();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", {
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
    screen.queryByRole("button", { name: /Agent Networks connector/ }),
  ).not.toBeInTheDocument();
});

test.each([true, false])(
  "removal clears %s enabled connector and restores keyboard focus to +",
  async (enabled) => {
    mockApi.getCocalcConnectorConfig.mockResolvedValue({ ...config, enabled });
    const user = userEvent.setup();
    render(<Controls />);
    const icon = await screen.findByRole("button", {
      name: /^CoCalc connector/,
    });
    icon.focus();
    await user.keyboard("{Enter}");
    const remove = await screen.findByRole("button", {
      name: "Remove connector",
    });
    await waitFor(() => expect(remove).toBeEnabled());
    remove.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Remove CoCalc connector?" }),
    ).toBeVisible();
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
        screen.queryByRole("button", { name: /^CoCalc connector/ }),
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
    await user.click(screen.getByRole("menuitem", { name: "CoCalc" }));
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
  await user.click(
    await screen.findByRole("button", { name: "CoCalc connector" }),
  );
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
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "CoCalc connector" }),
    ).toHaveFocus(),
  );
});

test("no config means no connector icon, and unregistered chats keep only the original menu", async () => {
  const user = userEvent.setup();
  const view = render(<Controls />);
  await waitFor(() =>
    expect(mockApi.getCocalcConnectorConfig).toHaveBeenCalled(),
  );
  expect(
    screen.queryByRole("button", { name: /connector/ }),
  ).not.toBeInTheDocument();
  view.rerender(<Controls value={null} />);
  await user.click(screen.getByRole("button", { name: "Add files and more" }));
  expect(
    screen.queryByRole("menuitem", { name: "Agent Networks" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "CoCalc" }),
  ).not.toBeInTheDocument();
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
  await user.click(screen.getByRole("menuitem", { name: "Agent Networks" }));
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
    name: "CoCalc (Codex only)",
  });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  expect(mockApi.getCocalcConnectorConfig).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /^CoCalc connector/ }),
  ).toBeNull();

  const networks = screen.getByRole("menuitem", { name: "Agent Networks" });
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
    await screen.findByRole("button", { name: "CoCalc connector" }),
  ).toBeVisible();
  view.rerender(<Controls supportsCocalcAccess={false} />);
  expect(
    screen.queryByRole("button", { name: /^CoCalc connector/ }),
  ).toBeNull();
  expect(mockApi.saveCocalcConnectorConfig).not.toHaveBeenCalled();
  expect(mockApi.removeCocalcConnectorConfig).not.toHaveBeenCalled();
});
