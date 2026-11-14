import { DatabaseSync } from "node:sqlite";
import {
  createNamedAgents,
  MAX_NAMED_AGENTS,
  normalizeAgentChatPath,
} from "../../named-agents";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-000000000000";
const OTHER = "00000000-1000-4000-8000-0000000000ff";
const PATH = "/home/u/.local/share/cocalc/agents/a.chat";

function setup(
  threads: Record<string, Record<string, any>> = {
    t1: { agent_kind: "acp", name: "Helper", color: "#f00" },
    t2: {
      agent_kind: "acp",
      name: "Claude one",
      agent_runtime: {
        profile: { version: 2, id: "claude-code" },
      },
    },
  },
) {
  const db = new DatabaseSync(":memory:") as any;
  let successor = 0;
  const prepared: any[] = [];
  const agents = createNamedAgents({
    account_id: ACCOUNT,
    project_id: PROJECT,
    db: () => db,
    readThread: async ({ thread_id }) => threads[thread_id],
    prepareFreshThread: async (opts) => {
      prepared.push(opts);
      return `fresh-${++successor}`;
    },
  });
  return { agents, db, prepared };
}

const register = (agents: any, thread_id = "t1") =>
  agents.registerIdentity({ project_id: PROJECT, path: PATH, thread_id });

describe("agent identities", () => {
  it("registers a thread once, with its runtime and look", async () => {
    const { agents } = setup();
    const a = await register(agents);
    expect(a).toMatchObject({
      project_id: PROJECT,
      path: PATH,
      thread_id: "t1",
      name: "Helper",
      created_by: ACCOUNT,
      disabled_at: null,
      appearance: { color: "#f00" },
      runtime: { kind: "codex" },
    });
    expect(await register(agents)).toEqual(a);
    expect((await register(agents, "t2")).runtime).toEqual({
      kind: "claude-code",
    });
    expect(await agents.getIdentity({ agent_id: a.agent_id })).toEqual(a);
    expect(
      await agents.resolveIdentity({
        project_id: PROJECT,
        path: PATH,
        thread_id: "t1",
      }),
    ).toEqual(a);
    expect(
      await agents.resolveIdentity({
        project_id: PROJECT,
        path: "virtual-path",
        thread_id: "t1",
      }),
    ).toBeUndefined();
  });

  it("refuses non-agent threads, other projects and other accounts", async () => {
    const { agents } = setup({ human: { agent_kind: "none" } });
    await expect(register(agents, "human")).rejects.toThrow(
      "non-archived agent thread",
    );
    await expect(register(agents, "missing")).rejects.toThrow();
    await expect(
      agents.registerIdentity({
        project_id: OTHER,
        path: PATH,
        thread_id: "t1",
      }),
    ).rejects.toThrow("not available");
    await expect(
      agents.registerIdentity({
        account_id: OTHER,
        project_id: PROJECT,
        path: PATH,
        thread_id: "t1",
      }),
    ).rejects.toThrow("only the local account");
    expect(() => normalizeAgentChatPath("notes.md")).toThrow(".chat");
    expect(normalizeAgentChatPath("/a/../b/x.chat")).toBe("/b/x.chat");
  });

  it("starts a fresh conversation, idempotently, keeping name and payment", async () => {
    const { agents, prepared } = setup();
    const a = await register(agents);
    await agents.nameAgent({
      endpoint: { project_id: PROJECT, agent_id: a.agent_id },
      name: "helper",
    });
    await agents.setPaymentSelections({
      targets: [{ project_id: PROJECT, thread_id: "t1", path: PATH }],
      selection: { version: 1, provider: "codex", mode: "default" },
    });
    const fresh = await agents.startFreshConversation({
      project_id: PROJECT,
      agent_id: a.agent_id,
      expected_thread_id: "t1",
    });
    expect(fresh.agent_id).toBe(a.agent_id);
    expect(fresh.thread_id).toBe("fresh-1");
    expect(fresh.conversation_history).toEqual([
      { thread_id: "t1", ended_at: expect.any(String) },
    ]);
    expect(prepared).toEqual([
      { account_id: ACCOUNT, project_id: PROJECT, path: PATH, thread_id: "t1" },
    ]);
    // A retry with the old thread returns the same result.
    expect(
      await agents.startFreshConversation({
        project_id: PROJECT,
        agent_id: a.agent_id,
        expected_thread_id: "t1",
      }),
    ).toEqual(fresh);
    expect(prepared).toHaveLength(1);
    await expect(
      agents.startFreshConversation({
        project_id: PROJECT,
        agent_id: a.agent_id,
        expected_thread_id: "elsewhere",
      }),
    ).rejects.toThrow("changed");
    const { agents: list } = await agents.listNamedAgents({});
    expect(list[0]).toMatchObject({ name: "helper", thread_id: "fresh-1" });
    expect(list[0].payment).toEqual([
      expect.objectContaining({
        thread_id: "fresh-1",
        selection: { version: 1, provider: "codex", mode: "default" },
      }),
    ]);
  });
});

describe("names", () => {
  it("names, renames and retires an agent", async () => {
    const { agents } = setup();
    const a = await register(agents);
    const endpoint = { project_id: PROJECT, agent_id: a.agent_id };
    const named = await agents.nameAgent({
      endpoint,
      name: " Helper ",
      description: "reviews",
    });
    expect(named).toMatchObject({
      account_id: ACCOUNT,
      name: "helper",
      endpoint,
      path: PATH,
      thread_id: "t1",
      description: "reviews",
      available: true,
      appearance: { color: "#f00" },
      runtime: { kind: "codex" },
    });
    await agents.nameAgent({ endpoint, name: "reviewer" });
    const directory = await agents.listNamedAgents({});
    expect(directory.agents.map((x: any) => x.name)).toEqual(["reviewer"]);
    expect(directory).toMatchObject({
      enabled: true,
      usage: { active: 1, limit: MAX_NAMED_AGENTS },
      controls: { paused: false },
    });
    await agents.retireNamedAgent({ endpoint });
    expect((await agents.listNamedAgents({})).agents).toEqual([]);
  });

  it("keeps a name for one agent and validates names", async () => {
    const { agents } = setup();
    const a = await register(agents);
    const b = await register(agents, "t2");
    await agents.nameAgent({
      endpoint: { project_id: PROJECT, agent_id: a.agent_id },
      name: "helper",
    });
    await expect(
      agents.nameAgent({
        endpoint: { project_id: PROJECT, agent_id: b.agent_id },
        name: "helper",
      }),
    ).rejects.toThrow("name_reserved");
    for (const bad of ["", "9lives", "everyone", "a b", "x".repeat(40)])
      await expect(
        agents.nameAgent({
          endpoint: { project_id: PROJECT, agent_id: b.agent_id },
          name: bad,
        }),
      ).rejects.toThrow();
    await expect(
      agents.nameAgent({
        endpoint: { project_id: PROJECT, agent_id: OTHER },
        name: "ghost",
      }),
    ).rejects.toThrow("agent not found");
  });
});

describe("payment selections", () => {
  it("stores, reads, defaults and clears selections", async () => {
    const { agents } = setup();
    const t = { project_id: PROJECT, thread_id: "t1", path: PATH };
    const claude = {
      version: 1 as const,
      provider: "claude-code" as const,
      mode: "project-secret" as const,
    };
    expect(
      await agents.setPaymentSelections({ targets: [t], selection: claude }),
    ).toEqual({ updated: 1 });
    await agents.setPaymentSelections({
      defaults: ["codex"],
      selection: { version: 1, provider: "codex", mode: "default" },
    });
    const got = await agents.getPaymentSelections({ targets: [t] });
    expect(got.selections).toEqual([
      expect.objectContaining({ thread_id: "t1", selection: claude }),
    ]);
    expect(got.defaults).toEqual({
      codex: { version: 1, provider: "codex", mode: "default" },
    });
    // only_if_absent keeps an existing choice.
    await agents.setPaymentSelections({
      targets: [t],
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "subscription-pool",
      },
      only_if_absent: true,
    });
    expect(
      (await agents.listPaymentSelections({ provider: "claude-code" }))
        .selections[0].selection,
    ).toEqual(claude);
    await agents.setPaymentSelections({
      targets: [t],
      selection: null,
      provider: "claude-code",
    });
    expect(
      (await agents.getPaymentSelections({ targets: [t] })).selections,
    ).toEqual([]);
    await expect(
      agents.setPaymentSelections({
        targets: [t],
        selection: { version: 1, provider: "codex", mode: "nope" } as any,
      }),
    ).rejects.toThrow();
  });
});
