import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";
import {
  agentNetworkLookupKey,
  indexAgentNetworks,
  matchesAgentSidebarSearch,
} from "./sidebar-search";

const agent = {
  name: "reviewer",
  thread_title: "Review changes",
  project_title: "Dev",
} as NamedAgent;
const network = { title: "Sagejs" } as AgentNetwork;

test("plain sidebar search includes network tag names", () => {
  expect(
    matchesAgentSidebarSearch({ agent, networks: [network], query: "sage" }),
  ).toBe(true);
  expect(
    matchesAgentSidebarSearch({ agent, networks: [], query: "sage" }),
  ).toBe(false);
  expect(
    matchesAgentSidebarSearch({ agent, networks: [network], query: "review" }),
  ).toBe(true);
});

test("tag: search matches only network tags, case-insensitively", () => {
  expect(
    matchesAgentSidebarSearch({
      agent,
      networks: [network],
      query: "tag:sagejs",
    }),
  ).toBe(true);
  expect(
    matchesAgentSidebarSearch({
      agent,
      networks: [network],
      query: "TAG:SAGE",
    }),
  ).toBe(true);
  expect(
    matchesAgentSidebarSearch({ agent, networks: [], query: "tag:review" }),
  ).toBe(false);
  expect(
    matchesAgentSidebarSearch({ agent, networks: [network], query: "tag:" }),
  ).toBe(true);
  expect(
    matchesAgentSidebarSearch({ agent, networks: [], query: "tag:" }),
  ).toBe(false);
});

test("indexes active memberships without closed, removed, or duplicate tags", () => {
  const member = {
    kind: "registered",
    endpoint: { project_id: "project-1", agent_id: "agent-1" },
  } as AgentNetwork["members"][number];
  const active = {
    title: "Sagejs",
    state: "active",
    members: [member, member],
  } as AgentNetwork;
  const removed = {
    ...member,
    removed_at: "2026-09-24T00:00:00Z",
  } as AgentNetwork["members"][number];
  const paused = {
    title: "Review",
    state: "paused",
    members: [member],
  } as AgentNetwork;
  const closed = {
    title: "Old",
    state: "closed",
    members: [member],
  } as AgentNetwork;
  const index = indexAgentNetworks([
    active,
    { title: "Removed", state: "active", members: [removed] } as AgentNetwork,
    paused,
    closed,
  ]);

  expect(index.get(agentNetworkLookupKey("project-1", "agent-1"))).toEqual([
    active,
    paused,
  ]);
});
