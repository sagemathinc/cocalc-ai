import { agentMentionSuggestions } from "./mention-suggestions";
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
