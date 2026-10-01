import { createHash } from "node:crypto";
import { EXTERNAL_CREDENTIAL_CONFLICT } from "@cocalc/util/external-credential-conflict";

jest.mock("@cocalc/server/external-credentials/routing", () => ({}));
import { AGENT_MEMORY_DISABLED, createAgentMemory } from "./memory";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function fakeStore() {
  const state: {
    id?: string;
    payload?: string;
    writes: number;
    actors: string[];
  } = { writes: 0, actors: [] };
  let beforeWrite: (() => void) | undefined;
  return {
    state,
    onceBeforeWrite(f: () => void) {
      beforeWrite = f;
    },
    store: {
      async get(_account: string, actor: string) {
        state.actors.push(`get:${actor}`);
        return state.id ? { id: state.id, payload: state.payload! } : undefined;
      },
      async create(_account: string, payload: string, actor: string) {
        state.actors.push(`create:${actor}`);
        beforeWrite?.();
        beforeWrite = undefined;
        if (state.id) throw Error("at most 1 active credentials are allowed");
        state.id = "id-1";
        state.payload = payload;
        state.writes++;
      },
      async update(
        _a: string,
        id: string,
        payload: string,
        sha: string,
        actor: string,
      ) {
        state.actors.push(`update:${actor}`);
        beforeWrite?.();
        beforeWrite = undefined;
        const current = createHash("sha256")
          .update(state.payload!)
          .digest("hex");
        if (id !== state.id || current !== sha)
          throw Error(EXTERNAL_CREDENTIAL_CONFLICT);
        state.payload = payload;
        state.writes++;
      },
    },
  };
}

test("agent operations require the owner to enable memory", async () => {
  const { store } = fakeStore();
  const memory = createAgentMemory(store as any);
  await expect(
    memory.agent(ACCOUNT, { action: "memory", op: "list" }),
  ).rejects.toThrow(AGENT_MEMORY_DISABLED);
  await expect(
    memory.agent(ACCOUNT, {
      action: "memory",
      op: "write",
      name: "a",
      description: "d",
      body: "b",
    }),
  ).rejects.toThrow(AGENT_MEMORY_DISABLED);
  expect(await memory.turnIndex(ACCOUNT)).toBeUndefined();
  expect(await memory.owner(ACCOUNT, { op: "status" })).toMatchObject({
    enabled: false,
    notes: 0,
  });
});

test("enabled memory supports write, list, read, delete and the turn index", async () => {
  const { store, state } = fakeStore();
  const memory = createAgentMemory(store as any);
  await memory.owner(ACCOUNT, { op: "set-enabled", enabled: true });
  expect(
    await memory.agent(ACCOUNT, {
      action: "memory",
      op: "write",
      name: "deploy",
      description: "How to deploy",
      body: "Use a project terminal.",
    }),
  ).toEqual({ name: "deploy", saved: "created" });
  expect(await memory.agent(ACCOUNT, { action: "memory", op: "list" })).toEqual(
    {
      notes: [
        {
          name: "deploy",
          description: "How to deploy",
          updated_at: expect.any(String),
        },
      ],
    },
  );
  expect(
    await memory.agent(ACCOUNT, {
      action: "memory",
      op: "read",
      name: "deploy",
    }),
  ).toMatchObject({ body: "Use a project terminal." });
  expect(await memory.turnIndex(ACCOUNT)).toEqual({
    notes: 1,
    index: "- deploy: How to deploy",
  });
  const writes = state.writes;
  // A no-op delete does not write.
  expect(
    await memory.agent(ACCOUNT, {
      action: "memory",
      op: "delete",
      name: "nope",
    }),
  ).toEqual({ name: "nope", deleted: false });
  expect(state.writes).toBe(writes);
  // Turning memory off blocks agents but keeps notes for the owner.
  await memory.owner(ACCOUNT, { op: "set-enabled", enabled: false });
  await expect(
    memory.agent(ACCOUNT, { action: "memory", op: "read", name: "deploy" }),
  ).rejects.toThrow(AGENT_MEMORY_DISABLED);
  expect(
    ((await memory.owner(ACCOUNT, { op: "list" })) as any).notes_list,
  ).toHaveLength(1);
});

test("rejects secrets, and retries the first-write race and CAS conflicts", async () => {
  const { store, state, onceBeforeWrite } = fakeStore();
  const memory = createAgentMemory(store as any);
  // Another session creates the record between this read and create.
  onceBeforeWrite(() => {
    state.id = "id-1";
    state.payload = JSON.stringify({ version: 1, enabled: true, notes: [] });
  });
  await memory.owner(ACCOUNT, { op: "set-enabled", enabled: true });
  expect(JSON.parse(state.payload!).enabled).toBe(true);
  await expect(
    memory.agent(ACCOUNT, {
      action: "memory",
      op: "write",
      name: "k",
      description: "d",
      body: "ghp_" + "a".repeat(36),
    }),
  ).rejects.toThrow(/secrets/);
  // A concurrent update conflicts once, then succeeds without losing it.
  onceBeforeWrite(() => {
    const record = JSON.parse(state.payload!);
    record.notes.push({
      name: "other",
      description: "o",
      body: "o",
      updated_at: new Date().toISOString(),
    });
    state.payload = JSON.stringify(record);
  });
  await memory.agent(ACCOUNT, {
    action: "memory",
    op: "write",
    name: "mine",
    description: "m",
    body: "m",
  });
  expect(JSON.parse(state.payload!).notes.map((n: any) => n.name)).toEqual([
    "other",
    "mine",
  ]);
});

test("a corrupt record fails closed for agents but delete-all repairs it", async () => {
  const { store, state } = fakeStore();
  state.id = "id-1";
  state.payload = "{corrupt";
  const memory = createAgentMemory(store as any);
  await expect(
    memory.agent(ACCOUNT, { action: "memory", op: "list" }),
  ).rejects.toThrow(/unreadable/);
  await memory.owner(ACCOUNT, { op: "delete-all" });
  expect(JSON.parse(state.payload!)).toEqual({
    version: 1,
    enabled: false,
    notes: [],
  });
});

test("only agent operations are charged; the owner's settings actions never are", async () => {
  const { store, state } = fakeStore();
  const memory = createAgentMemory(store as any);
  await memory.owner(ACCOUNT, { op: "set-enabled", enabled: true });
  await memory.owner(ACCOUNT, { op: "status" });
  expect(state.actors.every((a) => a.endsWith(":owner"))).toBe(true);
  state.actors = [];
  await memory.agent(ACCOUNT, {
    action: "memory",
    op: "write",
    name: "x",
    description: "d",
    body: "b",
  });
  await memory.turnIndex(ACCOUNT);
  expect(state.actors.length).toBeGreaterThan(0);
  expect(state.actors.every((a) => a.endsWith(":agent"))).toBe(true);
  state.actors = [];
  await memory.owner(ACCOUNT, { op: "set-enabled", enabled: false });
  await memory.owner(ACCOUNT, { op: "delete-all" });
  expect(state.actors.every((a) => a.endsWith(":owner"))).toBe(true);
});
