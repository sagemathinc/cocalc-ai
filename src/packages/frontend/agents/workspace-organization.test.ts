import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
  groupAgentsByProject,
  groupAgentsByRecency,
  markAgentActive,
  moveAgent,
  moveAgentBefore,
  moveAgentToIndex,
  moveAgentWithinProject,
  normalizeAgentWorkspaceOrganization,
  organizeAgents,
  serializeAgentWorkspaceOrganization,
  setAgentHidden,
  setAgentPinned,
} from "./workspace-organization";

function agent(id: string, name = id): NamedAgent {
  return {
    account_id: "account",
    name,
    endpoint: { project_id: "project", agent_id: id },
    path: `${id}.chat`,
    thread_id: id,
    available: true,
    updated_at: new Date(0).toISOString(),
  };
}

const agents = [agent("a"), agent("b"), agent("c")];

it("normalizes malformed and oversized organization data", () => {
  const normalized = normalizeAgentWorkspaceOrganization({
    mode: "invalid",
    pinned: ["b", "b", 1],
    custom: "bad",
    lastOpened: { a: 20, b: "bad", c: -1 },
  });
  expect(normalized).toEqual({
    version: 1,
    mode: "recent",
    groupByProject: false,
    pinned: ["b"],
    custom: [],
    hidden: [],
    collapsedProjects: [],
    lastOpened: { a: 20 },
  });
});

it("accepts numeric-key maps produced by shallow account-setting storage", () => {
  expect(
    normalizeAgentWorkspaceOrganization({
      pinned: { 1: "b", 0: "a" },
      custom: { 0: "c" },
    }),
  ).toMatchObject({ pinned: ["a", "b"], custom: ["c"] });
});

it("serializes replaceable collections as account-setting scalars", () => {
  const serialized = serializeAgentWorkspaceOrganization({
    ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    pinned: [],
    custom: ["b"],
    lastOpened: { b: 123 },
  });
  expect(serialized).toMatchObject({
    pinned: "[]",
    custom: '["b"]',
    hidden: "[]",
    collapsedProjects: "[]",
    lastOpened: '{"b":123}',
  });
  expect(normalizeAgentWorkspaceOrganization(serialized)).toMatchObject({
    pinned: [],
    custom: ["b"],
    lastOpened: { b: 123 },
  });
});

it("orders pinned agents separately from recently opened agents", () => {
  const organization = {
    ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    pinned: ["c"],
    lastOpened: { a: 10, b: 30 },
  };
  const result = organizeAgents(agents, organization);
  expect(result.pinned.map((x) => x.name)).toEqual(["c"]);
  expect(result.unpinned.map((x) => x.name)).toEqual(["b", "a"]);
});

it("supports pinning and accessible relative movement", () => {
  let organization = setAgentPinned(
    agents,
    DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    "b",
    true,
  );
  organization = setAgentPinned(agents, organization, "c", true);
  organization = moveAgent(agents, organization, "c", -1);
  expect(organization.pinned).toEqual(["c", "b"]);
  const custom = moveAgent(
    agents,
    DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    "b",
    -1,
  );
  expect(custom.mode).toBe("custom");
  expect(custom.custom).toEqual(["b", "a", "c"]);
});

it("supports drag ordering without crossing the pinned boundary", () => {
  const organization = {
    ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    pinned: ["a"],
    custom: ["b", "c"],
    mode: "custom" as const,
  };
  expect(moveAgentBefore(agents, organization, "c", "b").custom).toEqual([
    "c",
    "b",
  ]);
  expect(moveAgentBefore(agents, organization, "a", "b")).toBe(organization);
});

it("moves agents to an exact sortable-list index", () => {
  expect(
    moveAgentToIndex(agents, DEFAULT_AGENT_WORKSPACE_ORGANIZATION, "a", 2),
  ).toMatchObject({ mode: "custom", custom: ["b", "c", "a"] });
  expect(
    moveAgentToIndex(
      agents,
      { ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION, pinned: ["a", "b"] },
      "b",
      0,
    ).pinned,
  ).toEqual(["b", "a"]);
});

it("records activity timestamps without regressing to stale activity", () => {
  expect(
    markAgentActive(DEFAULT_AGENT_WORKSPACE_ORGANIZATION, "a", 123).lastOpened,
  ).toEqual({ a: 123 });
  const current = {
    ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    lastOpened: { a: 123 },
  };
  expect(markAgentActive(current, "a", 100)).toBe(current);
});

it("groups recent agents into the workspace time buckets", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const sections = groupAgentsByRecency(
    agents,
    {
      a: now - 1_000,
      b: now - 3 * 24 * 60 * 60 * 1000,
    },
    now,
  );
  expect(
    sections.map(({ title, agents }) => [
      title,
      agents.map(({ name }) => name),
    ]),
  ).toEqual([
    ["Today", ["a"]],
    ["Last 7 days", ["b"]],
    ["Older", ["c"]],
  ]);
});

it("groups ordered agents by project and orders projects by activity", () => {
  const projectA = {
    ...agent("a", "A"),
    project_title: "Alpha",
  };
  const projectB = {
    ...agent("b", "B"),
    endpoint: { project_id: "project-b", agent_id: "b" },
    project_title: "Beta",
  };
  const projectBPin = {
    ...agent("c", "C"),
    endpoint: { project_id: "project-b", agent_id: "c" },
    project_title: "Beta",
  };

  expect(
    groupAgentsByProject([projectBPin], [projectA, projectB], {
      a: 10,
      b: 30,
      c: 20,
    }).map(({ projectTitle, pinned, unpinned }) => ({
      projectTitle,
      pinned: pinned.map(({ name }) => name),
      unpinned: unpinned.map(({ name }) => name),
    })),
  ).toEqual([
    { projectTitle: "Beta", pinned: ["C"], unpinned: ["B"] },
    { projectTitle: "Alpha", pinned: [], unpinned: ["A"] },
  ]);
});

it("reorders agents within a project without disturbing other projects", () => {
  const mixed = [
    agent("a"),
    {
      ...agent("x"),
      endpoint: { project_id: "other", agent_id: "x" },
    },
    agent("b"),
  ];
  const organization = {
    ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION,
    mode: "custom" as const,
    custom: ["a", "x", "b"],
  };

  expect(
    moveAgentWithinProject(mixed, organization, "b", ["a", "b"], 0).custom,
  ).toEqual(["b", "x", "a"]);
});

it("hides and restores an agent without disabling its identity", () => {
  const hidden = setAgentHidden(
    agents,
    { ...DEFAULT_AGENT_WORKSPACE_ORGANIZATION, pinned: ["b"] },
    "b",
    true,
  );
  expect(hidden).toMatchObject({ pinned: [], hidden: ["b"] });
  expect(organizeAgents(agents, hidden).hidden.map(({ name }) => name)).toEqual(
    ["b"],
  );
  expect(setAgentHidden(agents, hidden, "b", false).hidden).toEqual([]);
});
