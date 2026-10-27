import {
  agentMentionSuggestions,
  externalAgentMentionSuggestions,
} from "./mention-suggestions";
import type { NamedAgent, AgentNetwork } from "@cocalc/conat/agents/personal";
const agents = Array.from(
  { length: 12 },
  (_, i) =>
    ({
      name: `agent-${i}`,
      endpoint: { agent_id: `${i}`, project_id: "project" },
      path: "chat",
      thread_id: `${i}`,
      available: true,
    }) as NamedAgent,
);
const network = (id: string, members: number[]): AgentNetwork =>
  ({
    agent_network_id: id,
    title: id,
    state: "active",
    members: members.map((i) => ({
      kind: "registered",
      endpoint: agents[i].endpoint,
    })),
  }) as AgentNetwork;
const base = {
  agents,
  networks: [
    network("selected", [0, 1, 2]),
    network("other", [0, ...Array.from({ length: 8 }, (_, i) => i + 3)]),
  ],
  source: { projectId: "project", path: "chat", threadId: "0" },
  selectedNetworkId: "selected",
  query: "",
  activity: { "2": 30, "3": 50 },
};
it("prioritizes selected network then recent connected agents, excludes self, caps at eight", () => {
  const result = agentMentionSuggestions(base);
  expect(result.rows.slice(0, 3).map(({ agent }) => agent.name)).toEqual([
    "agent-2",
    "agent-1",
    "agent-3",
  ]);
  expect(result.rows).toHaveLength(8);
  expect(result.hasMore).toBe(true);
  expect(result.rows.every(({ connected }) => connected)).toBe(true);
});
it("finds unconnected agents through global search without claiming connection", () => {
  const result = agentMentionSuggestions({ ...base, query: "agent-11" });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].connected).toBe(false);
});
it("does not treat the selected network or a paused network as permission", () => {
  const result = agentMentionSuggestions({
    ...base,
    networks: [network("selected", [1, 2])],
  });
  expect(result.rows.every(({ connected }) => !connected)).toBe(true);
  expect(
    agentMentionSuggestions({ ...base, paused: true }).rows.every(
      ({ connected }) => !connected,
    ),
  ).toBe(true);
});

describe("agents on other sites", () => {
  const remote = (id: string, label: string, removed = false) => ({
    kind: "external" as const,
    member_id: id,
    source: {
      kind: "external" as const,
      account_id: "acct",
      agent_id: id,
      installation_id: `install-${id}`,
    },
    label,
    available: true,
    added_at: "",
    ...(removed ? { removed_at: "gone" } : {}),
  });
  const withRemote = (
    id: string,
    state: string,
    members: any[],
    withSource = true,
  ): AgentNetwork =>
    ({
      agent_network_id: id,
      account_id: "owner",
      title: id,
      state,
      members: [
        ...(withSource
          ? [{ kind: "registered", endpoint: agents[0].endpoint }]
          : []),
        ...members,
      ],
    }) as AgentNetwork;

  test("lists each external member once, by its handle, connected first", () => {
    const ops0 = remote("ops0", "ops0 on alpha.cocalc.ai (ops project)");
    const result = externalAgentMentionSuggestions({
      networks: [
        withRemote("a", "active", [ops0]),
        withRemote("b", "active", [ops0], false),
        withRemote("c", "active", [remote("far", "far away")], false),
        withRemote("d", "active", [remote("old", "old one", true)]),
        withRemote("e", "active", [remote("nameless", "!!!")]),
      ],
      sourceEndpoint: agents[0].endpoint,
      query: "",
    });
    // Unconnected ones wait for a search; removed and unnamed ones never show.
    expect(result.rows.map(({ handle }) => handle)).toEqual(["ops0"]);
    expect(result.rows[0]).toMatchObject({
      connected: true,
      account_id: "owner",
    });
    expect(result.hasMore).toBe(true);
    const all = externalAgentMentionSuggestions({
      networks: [
        withRemote("a", "active", [ops0]),
        withRemote("c", "active", [remote("far", "far away")], false),
      ],
      sourceEndpoint: agents[0].endpoint,
      query: "far",
    });
    expect(all.rows).toMatchObject([{ handle: "far", connected: false }]);
  });

  test("a paused shared network is said to be paused, not connected", () => {
    const result = externalAgentMentionSuggestions({
      networks: [withRemote("a", "paused", [remote("ops0", "ops0")])],
      sourceEndpoint: agents[0].endpoint,
      query: "ops",
    });
    expect(result.rows).toMatchObject([{ connected: false, paused: true }]);
  });
});
