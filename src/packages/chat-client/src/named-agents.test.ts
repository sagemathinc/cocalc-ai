import {
  filterNamedAgents,
  loadNamedAgentWorkspace,
  resolveNamedAgentHost,
  saveNamedAgentOrganization,
} from "./named-agents";
import {
  normalizeAgentWorkspaceOrganization,
  MY_AGENTS_ORGANIZATION_SETTING,
  organizeAgents,
} from "./agent-organization";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const agent = (id: string, name = id): NamedAgent => ({
  account_id: "account",
  name,
  endpoint: { project_id: "project", agent_id: id },
  path: "agent.chat",
  thread_id: id,
  available: true,
  updated_at: "2026-09-21",
  project_title: "Research",
});

describe("named agent workspace", () => {
  it("reads registered agents and account organization without enumerating project sessions", async () => {
    const userQuery = jest
      .fn()
      .mockResolvedValue({
        accounts: [
          {
            account_id: "account",
            other_settings: {
              [MY_AGENTS_ORGANIZATION_SETTING]: {
                pinned: '["b"]',
                hidden: '["c"]',
              },
            },
          },
        ],
      });
    const listNamedAgents = jest
      .fn()
      .mockResolvedValue({
        enabled: true,
        agents: [agent("a"), agent("b"), agent("c")],
      });
    const loaded = await loadNamedAgentWorkspace(
      { agent: { listNamedAgents }, db: { userQuery } },
      "account",
    );
    const groups = organizeAgents(loaded.directory.agents, loaded.organization);
    expect(groups.pinned.map((a) => a.name)).toEqual(["b"]);
    expect(groups.unpinned.map((a) => a.name)).toEqual(["a"]);
    expect(groups.hidden.map((a) => a.name)).toEqual(["c"]);
    expect(userQuery).toHaveBeenCalledTimes(1);
    expect(listNamedAgents).toHaveBeenCalledWith({});
  });
  it("does not replace an unreadable account preference with empty state", async () => {
    await expect(
      loadNamedAgentWorkspace(
        {
          agent: {
            listNamedAgents: jest
              .fn()
              .mockResolvedValue({ enabled: true, agents: [] }),
          },
          db: { userQuery: jest.fn().mockResolvedValue({ accounts: [] }) },
        },
        "account",
      ),
    ).rejects.toThrow("organization");
  });
  it("writes only the organization preference and preserves replaceable array encoding", async () => {
    const userQuery = jest.fn().mockResolvedValue({});
    await saveNamedAgentOrganization(
      { db: { userQuery } },
      "account",
      normalizeAgentWorkspaceOrganization({ pinned: [] }),
    );
    const row = userQuery.mock.calls[0][0].query.accounts;
    expect(row.account_id).toBe("account");
    expect(Object.keys(row.other_settings)).toEqual([
      MY_AGENTS_ORGANIZATION_SETTING,
    ]);
    expect(row.other_settings[MY_AGENTS_ORGANIZATION_SETTING].pinned).toBe(
      "[]",
    );
  });
  it("resolves fresh placement only for the chosen project, including hidden projects", async () => {
    const userQuery = jest
      .fn()
      .mockResolvedValue({
        account_project_index: [
          { project_id: "project", host_id: "new-host", is_hidden: true },
        ],
      });
    await expect(
      resolveNamedAgentHost({ db: { userQuery } }, "account", "project"),
    ).resolves.toBe("new-host");
    expect(userQuery.mock.calls[0][0].query.account_project_index).toEqual([
      { account_id: "account", project_id: "project", host_id: null },
    ]);
  });
  it("reports missing placement without falling back to another project's host", async () => {
    const userQuery = jest
      .fn()
      .mockResolvedValue({
        account_project_index: [{ project_id: "other", host_id: "host" }],
      });
    await expect(
      resolveNamedAgentHost({ db: { userQuery } }, "account", "project"),
    ).rejects.toThrow("no available host");
  });
  it("matches all search words across agent metadata", () => {
    expect(
      filterNamedAgents(
        [agent("a", "Data analysis"), agent("b", "Writing")],
        "RESEARCH data",
      ).map((a) => a.name),
    ).toEqual(["Data analysis"]);
    expect(filterNamedAgents([agent("a")], "   ")).toHaveLength(1);
  });
});
