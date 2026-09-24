import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentNetwork,
  AgentNetworkDirectory,
  NamedAgent,
} from "@cocalc/conat/agents/personal";
import { AgentNetworkTagsEditor } from "./agent-network-tags-editor";
import {
  activeNetworkMembers,
  duplicateNetworkTitle,
} from "./agent-network-utils";

const mockApi = {
  createAgentNetwork: jest.fn(),
  updateAgentNetwork: jest.fn(),
};
const mockRefresh = jest.fn();
const mockFresh = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockFresh,
    freshAuthModalProps: {},
  }),
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshAgentNetworks: () => mockRefresh(),
  sameEndpoint: (
    a: { project_id: string; agent_id: string },
    b: { project_id: string; agent_id: string },
  ) => a.project_id === b.project_id && a.agent_id === b.agent_id,
}));

jest.mock("antd", () => {
  const actual = jest.requireActual("antd");
  const Select = ({
    "aria-label": ariaLabel,
    mode,
    value,
    onChange,
    options,
    tagRender,
  }: any) => {
    const [draft, setDraft] = require("react").useState("");
    return (
      <div data-mode={mode}>
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-controls="test-network-tag-options"
          aria-expanded="false"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !draft) return;
            onChange([...value, draft]);
            setDraft("");
          }}
        />
        {value.map((id: string) =>
          tagRender({
            value: id,
            label:
              options.find((option: any) => option.value === id)?.label ?? id,
            closable: true,
            onClose: () =>
              onChange(value.filter((selected: string) => selected !== id)),
          }),
        )}
        <div id="test-network-tag-options">
          {options.map((option: any) => (
            <button
              key={option.value}
              type="button"
              disabled={option.disabled}
              onClick={() => onChange([...value, option.value])}
            >
              Select {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  };
  return { ...actual, Select };
});

const agent: NamedAgent = {
  account_id: "account",
  name: "builder",
  endpoint: { project_id: "project", agent_id: "builder-id" },
  path: "/agents.chat",
  thread_id: "thread",
  available: true,
  updated_at: "2026-09-24T00:00:00.000Z",
};
const network: AgentNetwork = {
  agent_network_id: "11111111-1111-4111-8111-111111111111",
  account_id: "account",
  title: "Release",
  state: "active",
  delivery_mode: "live",
  generation: "generation",
  created_by: "account",
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T00:00:00.000Z",
  members: [],
};
const directory: AgentNetworkDirectory = {
  enabled: true,
  networks: [network],
  usage: { active_networks: 1, network_limit: 10, member_limit: 10 },
  controls: { paused: false, generation: 1 },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.createAgentNetwork.mockResolvedValue({});
  mockApi.updateAgentNetwork.mockResolvedValue({});
  mockFresh.mockImplementation(async (action) => {
    await action();
    return true;
  });
});

test("network identities remain stable and removed members are not active", () => {
  expect(duplicateNetworkTitle([network], " release ")).toBe(true);
  expect(
    duplicateNetworkTitle([network], "release", network.agent_network_id),
  ).toBe(false);
  expect(
    activeNetworkMembers({
      ...network,
      members: [
        {
          kind: "registered",
          member_id: agent.endpoint.agent_id,
          endpoint: agent.endpoint,
          available: true,
          added_at: "2026-09-24T00:00:00.000Z",
          removed_at: "2026-09-24T01:00:00.000Z",
        },
      ],
    }),
  ).toHaveLength(0);
});

test("tag selector explains permissions and creates a one-member live network", async () => {
  const user = userEvent.setup();
  const onOpenNetwork = jest.fn();
  render(
    <AgentNetworkTagsEditor
      agent={agent}
      directory={directory}
      onClose={jest.fn()}
      onOpenNetwork={onOpenNetwork}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Network tags for @builder" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Network tags are permissions, not just labels."),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Browse existing network tags" }),
  );
  expect(onOpenNetwork).toHaveBeenCalledWith(network);
  const selector = screen.getByRole("combobox", {
    name: "Network tags for @builder",
  });
  expect(selector.parentElement).toHaveAttribute("data-mode", "tags");
  await user.click(selector);
  expect(selector).toHaveFocus();
  await user.type(selector, "Planning{enter}");
  await waitFor(() =>
    expect(mockApi.createAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Planning",
        delivery_mode: "live",
        members: [{ kind: "registered", endpoint: agent.endpoint }],
      }),
    ),
  );
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("a sole member can remove their network tag", async () => {
  const user = userEvent.setup();
  const onOpenNetwork = jest.fn();
  const withMember: AgentNetwork = {
    ...network,
    members: [
      {
        kind: "registered",
        member_id: agent.endpoint.agent_id,
        endpoint: agent.endpoint,
        name: agent.name,
        available: true,
        added_at: "2026-09-24T00:00:00.000Z",
      },
    ],
  };
  render(
    <AgentNetworkTagsEditor
      agent={agent}
      directory={{ ...directory, networks: [withMember] }}
      onClose={jest.fn()}
      onOpenNetwork={onOpenNetwork}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Network tags (1) for @builder" }),
  ).toBeInTheDocument();
  const configure = screen.getByRole("button", {
    name: "Configure Release network tag",
  });
  configure.focus();
  await user.keyboard("{Enter}");
  expect(onOpenNetwork).toHaveBeenCalledWith(withMember);
  const remove = screen.getByRole("button", {
    name: "Remove Release network tag",
  });
  remove.focus();
  expect(remove).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockApi.updateAgentNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "remove-member",
        agent_network_id: network.agent_network_id,
        member: { kind: "registered", endpoint: agent.endpoint },
      }),
    ),
  );
});
