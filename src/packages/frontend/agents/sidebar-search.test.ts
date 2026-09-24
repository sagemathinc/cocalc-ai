import type { AgentNetwork, NamedAgent } from "@cocalc/conat/agents/personal";
import { matchesAgentSidebarSearch } from "./sidebar-search";

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
