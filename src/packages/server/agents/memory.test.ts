/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent memory against a real database: one row per note, namespaces and
// the projects that see them, the one-time move from the first version's
// single record, limits under concurrency, and the turn index. Encryption,
// the first version's record, the rehome fence and rate limits are doubles.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AGENT_MEMORY_DISABLED, createAgentMemory } from "./memory";

jest.mock("@cocalc/database/settings/secret-settings", () => ({}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const P1 = randomUUID();
const P2 = randomUUID();
const P3 = randomUUID();

// The first version's record, with a version that changes on every write.
class LegacyStore {
  records = new Map<string, { payload: string; version: string }>();
  private n = 0;
  set(account: string, payload: string) {
    this.records.set(account, { payload, version: `v${++this.n}` });
  }
  has(account: string) {
    return this.records.has(account);
  }
}

function setup() {
  const legacy = new LegacyStore();
  let beforeCharge: (() => Promise<void>) | undefined;
  const charges: string[] = [];
  const writable = jest.fn(async () => {});
  const memory = createAgentMemory({
    pool: () => getPool() as any,
    // Bound to the note's place, like the real cipher's associated data.
    encrypt: async (aad, text) =>
      `enc:${aad}:${Buffer.from(text).toString("base64")}`,
    decrypt: async (aad, value) => {
      const prefix = `enc:${aad}:`;
      if (!value.startsWith(prefix)) throw new Error("wrong associated data");
      return Buffer.from(value.slice(prefix.length), "base64").toString();
    },
    legacy: {
      get: async (account_id) => legacy.records.get(account_id),
      remove: async (account_id, version) => {
        const record = legacy.records.get(account_id);
        if (record && (version == null || record.version === version))
          legacy.records.delete(account_id);
      },
    },
    assertWritable: writable,
    charge: async (_account, op, bytes = 0) => {
      charges.push(`${op}:${bytes}`);
      const hook = beforeCharge;
      beforeCharge = undefined;
      await hook?.();
    },
  });
  return {
    memory,
    legacy,
    charges,
    writable,
    /** Runs once, after a request read its settings and before it acts. */
    onceBeforeCharge: (hook: () => Promise<void>) => {
      beforeCharge = hook;
    },
  };
}

async function newAccount(
  memory: ReturnType<typeof setup>["memory"],
  { namespaces = [] as { name: string; description?: string }[] } = {},
) {
  const account = randomUUID();
  await memory.owner(account, { op: "set-enabled", enabled: true });
  for (const ns of namespaces)
    await memory.owner(account, { op: "namespace-save", ...ns });
  return account;
}

const write = (
  memory: ReturnType<typeof setup>["memory"],
  account: string,
  project: string,
  name: string,
  body = `about ${name}`,
) =>
  memory.agent(account, project, {
    action: "memory",
    op: "write",
    name,
    description: `the ${name.split("/").pop()} note`,
    body,
  }) as Promise<any>;

const names = async (
  memory: ReturnType<typeof setup>["memory"],
  account: string,
  project: string,
) =>
  (
    (await memory.agent(account, project, {
      action: "memory",
      op: "list",
    })) as any
  ).notes.map((n: any) => n.name);

describeDb("agent memory", () => {
  beforeAll(async () => {
    await syncSchema({
      agent_memory_accounts: SCHEMA.agent_memory_accounts,
      agent_memory_notes: SCHEMA.agent_memory_notes,
    });
  });

  test("agents need the owner to turn memory on; then notes work as before", async () => {
    const { memory } = setup();
    const account = randomUUID();
    await expect(write(memory, account, P1, "deploy")).rejects.toThrow(
      AGENT_MEMORY_DISABLED,
    );
    expect(await memory.turnIndex(account, P1)).toBeUndefined();
    // An account that never used memory gets no row from turns.
    const { rows } = await getPool().query(
      "SELECT 1 FROM agent_memory_accounts WHERE account_id=$1",
      [account],
    );
    expect(rows).toHaveLength(0);
    await memory.owner(account, { op: "set-enabled", enabled: true });
    expect(await write(memory, account, P1, "deploy")).toEqual({
      name: "deploy",
      namespace: "global",
      saved: "created",
    });
    expect((await write(memory, account, P1, "deploy", "v2")).saved).toBe(
      "updated",
    );
    const note: any = await memory.agent(account, P2, {
      action: "memory",
      op: "read",
      name: "deploy",
    });
    expect(note).toMatchObject({ name: "deploy", body: "v2" });
    expect(
      await memory.agent(account, P1, {
        action: "memory",
        op: "delete",
        name: "deploy",
      }),
    ).toEqual({ name: "deploy", namespace: "global", deleted: true });
    expect(await names(memory, account, P1)).toEqual([]);
  });

  test("the first version's record moves into rows once, then is deleted", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    legacy.set(
      account,
      JSON.stringify({
        version: 1,
        enabled: true,
        notes: [
          {
            name: "prefs",
            description: "Preferences",
            body: "Be brief.",
            updated_at: "2026-10-01T00:00:00.000Z",
          },
          {
            name: "deploy",
            description: "Deploy",
            body: "Use a terminal.",
            updated_at: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const index = await memory.turnIndex(account, P1);
    expect(index?.notes).toBe(2);
    expect(index?.index).toContain("- deploy: Deploy");
    expect(legacy.has(account)).toBe(false);
    const read: any = await memory.agent(account, P1, {
      action: "memory",
      op: "read",
      name: "prefs",
    });
    expect(read).toMatchObject({
      namespace: "global",
      body: "Be brief.",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    // A record written again (by a hub still on the first version) is
    // absorbed too; the owner's on/off setting here stays as it is.
    legacy.set(
      account,
      JSON.stringify({
        version: 1,
        enabled: false,
        notes: [
          {
            name: "late",
            description: "Written by an old hub",
            body: "after the move",
            updated_at: "2026-10-12T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(await memory.owner(account, { op: "status" })).toMatchObject({
      enabled: true,
      notes: 3,
    });
    expect(legacy.has(account)).toBe(false);
  });

  test("rolling upgrade: an old hub's write during the move is not lost", async () => {
    const { memory, legacy, onceBeforeCharge } = setup();
    const account = randomUUID();
    const record = (body: string, updated_at: string) =>
      JSON.stringify({
        version: 1,
        enabled: true,
        notes: [{ name: "deploy", description: "Deploy", body, updated_at }],
      });
    legacy.set(account, record("before", "2026-10-01T00:00:00.000Z"));
    // The record changes after it was read, before it would be deleted.
    const get = legacy.records.get.bind(legacy.records);
    let raced = false;
    legacy.records.get = (key: string) => {
      const value = get(key);
      if (!raced && value) {
        raced = true;
        legacy.set(account, record("after", "2026-10-02T00:00:00.000Z"));
      }
      return value;
    };
    onceBeforeCharge(async () => {});
    await memory.turnIndex(account, P1);
    // Moved as read; the newer record was not deleted...
    expect(legacy.has(account)).toBe(true);
    // ...and the next use absorbs it, the newer note winning.
    const note: any = await memory.agent(account, P1, {
      action: "memory",
      op: "read",
      name: "deploy",
    });
    expect(note.body).toBe("after");
    expect(legacy.has(account)).toBe(false);
  });

  test("a note changed here after the move is not overwritten by an older record", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    const record = JSON.stringify({
      version: 1,
      enabled: true,
      notes: [
        {
          name: "deploy",
          description: "Deploy",
          body: "old",
          updated_at: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    legacy.set(account, record);
    await write(memory, account, P1, "deploy", "new");
    legacy.set(account, record);
    const note: any = await memory.agent(account, P1, {
      action: "memory",
      op: "read",
      name: "deploy",
    });
    expect(note.body).toBe("new");
  });

  test("an unreadable first-version record starts empty and is kept for the owner", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    legacy.set(account, "not json");
    expect(await memory.owner(account, { op: "status" })).toMatchObject({
      enabled: false,
      notes: 0,
    });
    expect(legacy.has(account)).toBe(true);
    // Delete all removes it.
    await memory.owner(account, { op: "delete-all" });
    expect(legacy.has(account)).toBe(false);
  });

  test("namespaces: seen only in the projects they are attached to", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, {
      namespaces: [
        { name: "dev", description: "CoCalc development" },
        { name: "math" },
      ],
    });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P2,
      namespaces: ["dev", "math"],
    });
    // A new note goes to the project's only namespace.
    expect((await write(memory, account, P1, "deploy")).name).toBe(
      "dev/deploy",
    );
    expect((await write(memory, account, P1, "global/prefs")).name).toBe(
      "prefs",
    );
    // P3 has no namespace: global notes only, and dev notes are invisible.
    expect(await names(memory, account, P3)).toEqual(["prefs"]);
    await expect(
      memory.agent(account, P3, {
        action: "memory",
        op: "read",
        name: "deploy",
      }),
    ).rejects.toThrow("no memory note named deploy");
    await expect(
      memory.agent(account, P3, {
        action: "memory",
        op: "read",
        name: "dev/deploy",
      }),
    ).rejects.toThrow("memory namespace dev is not available in this project");
    expect(
      (
        (await memory.agent(account, P3, {
          action: "memory",
          op: "search",
          query: "deploy",
        })) as any
      ).results,
    ).toEqual([]);
    // P2 sees both namespaces, so a new note must name one.
    await expect(write(memory, account, P2, "theorem")).rejects.toThrow(
      /several memory namespaces \(dev: CoCalc development; math\)/,
    );
    expect((await write(memory, account, P2, "math/theorem")).name).toBe(
      "math/theorem",
    );
    expect(await names(memory, account, P2)).toEqual([
      "prefs",
      "dev/deploy",
      "math/theorem",
    ]);
    // An existing note is updated where it is, not copied into a namespace.
    expect(await write(memory, account, P1, "prefs", "v2")).toEqual({
      name: "prefs",
      namespace: "global",
      saved: "updated",
    });
  });

  test("the same name in two visible namespaces must be qualified", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, { namespaces: [{ name: "dev" }] });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    await write(memory, account, P1, "global/deploy");
    await write(memory, account, P1, "dev/deploy");
    await expect(
      memory.agent(account, P1, {
        action: "memory",
        op: "read",
        name: "deploy",
      }),
    ).rejects.toThrow(
      "more than one memory note is named deploy (dev/deploy, global/deploy)",
    );
    expect(
      (
        (await memory.agent(account, P1, {
          action: "memory",
          op: "read",
          name: "global/deploy",
        })) as any
      ).namespace,
    ).toBe("global");
  });

  test("move: agents within what they see, the owner anywhere", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, {
      namespaces: [{ name: "dev" }, { name: "math" }],
    });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    await write(memory, account, P1, "global/sagebrush-f4", "F4 notes");
    expect(
      await memory.agent(account, P1, {
        action: "memory",
        op: "move",
        name: "sagebrush-f4",
        to: "dev",
      }),
    ).toEqual({ name: "dev/sagebrush-f4", from: "global", to: "dev" });
    await expect(
      memory.agent(account, P1, {
        action: "memory",
        op: "move",
        name: "sagebrush-f4",
        to: "math",
      }),
    ).rejects.toThrow("not available in this project");
    await memory.owner(account, {
      op: "move",
      namespace: "dev",
      name: "sagebrush-f4",
      to: "math",
    });
    // Its text survives the move (the ciphertexts are rewritten).
    expect(
      (
        await memory.owner(account, {
          op: "read",
          namespace: "math",
          name: "sagebrush-f4",
        })
      ).body,
    ).toBe("F4 notes");
    await write(memory, account, P1, "global/sagebrush-f4", "another");
    await expect(
      memory.owner(account, {
        op: "move",
        namespace: "global",
        name: "sagebrush-f4",
        to: "math",
      }),
    ).rejects.toThrow("math already has a note named sagebrush-f4");
  });

  test("limits hold per namespace, also for concurrent writes", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    // 499 notes, then two writers race for the last place.
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       SELECT $1, 'global', 'n-' || i, 'x', 'x', 2 FROM generate_series(1, 499) AS i`,
      [account],
    );
    const results = await Promise.allSettled([
      write(memory, account, P1, "racer-a"),
      write(memory, account, P1, "racer-b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.message,
    ).toMatch(/already has 500 notes in global; merge related notes/);
    // A full namespace still takes updates to its notes.
    expect((await write(memory, account, P1, "n-1")).saved).toBe("updated");
  });

  test("the account byte limit counts every namespace", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       VALUES ($1, 'global', 'huge', 'x', 'x', 7999990)`,
      [account],
    );
    await expect(
      write(memory, account, P1, "one-more", "x".repeat(100)),
    ).rejects.toThrow("agent memory has no room for this note");
  });

  test("the turn index: this project's namespace and notes first, the rest searchable", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, {
      namespaces: [{ name: "dev", description: "CoCalc development" }],
    });
    for (const project_id of [P1, P2])
      await memory.owner(account, {
        op: "set-project-namespaces",
        project_id,
        namespaces: ["dev"],
      });
    await write(memory, account, P1, "global/prefs");
    for (let i = 0; i < 150; i++)
      await getPool().query(
        `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes, updated_at)
         VALUES ($1, 'dev', $2, $3, 'x', 1, now() - interval '1 day')`,
        [
          account,
          `old-${i}`,
          `enc:agent-memory:${account}:dev:old-${i}:description:${Buffer.from("y".repeat(100)).toString("base64")}`,
        ],
      );
    await write(memory, account, P2, "dev/written-elsewhere");
    await write(memory, account, P1, "dev/written-here");
    const result = await memory.turnIndex(account, P1);
    expect(result?.notes).toBe(153);
    const index = result!.index;
    expect(index).toContain("- dev: CoCalc development");
    expect(index).toContain("New notes go to dev.");
    expect(index).toContain("Global (every project):\n- prefs: the prefs note");
    expect(index.indexOf("- written-here")).toBeLessThan(
      index.indexOf("- written-elsewhere"),
    );
    expect(index).toMatch(/\(\d+ more: `memory search <words>` finds them/);
    // A project without the namespace sees only the global note.
    expect((await memory.turnIndex(account, P3))?.index).toBe(
      "Saved notes (name: description), most relevant first:\n- prefs: the prefs note",
    );
  });

  test("reads are tracked; search and export see what the project sees", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, { namespaces: [{ name: "dev" }] });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    await write(
      memory,
      account,
      P1,
      "dev/lite4b-deploy",
      "Deploy in a terminal.",
    );
    await write(memory, account, P1, "global/prefs", "Be brief.");
    await memory.agent(account, P1, {
      action: "memory",
      op: "read",
      name: "lite4b-deploy",
    });
    const { notes_list } = await memory.owner(account, { op: "list" });
    const deploy = notes_list.find((n: any) => n.name === "lite4b-deploy");
    expect(deploy).toMatchObject({
      namespace: "dev",
      read_count: 1,
      project_id: P1,
    });
    expect(deploy.last_read_at).toBeTruthy();
    const search: any = await memory.agent(account, P1, {
      action: "memory",
      op: "search",
      query: "terminal",
    });
    expect(search.results.map((r: any) => r.name)).toEqual([
      "dev/lite4b-deploy",
    ]);
    const exported: any = await memory.agent(account, P3, {
      action: "memory",
      op: "export",
    });
    expect(exported.notes).toBe(1);
    expect(exported.markdown).toContain("### prefs");
    expect(exported.markdown).not.toContain("lite4b-deploy");
    const all = await memory.owner(account, { op: "export" });
    expect(all.notes).toBe(2);
    expect(all.markdown).toContain("### dev/lite4b-deploy");
    expect(
      await memory.agent(account, P1, { action: "memory", op: "namespaces" }),
    ).toEqual({
      global_notes: 1,
      namespaces: [{ name: "dev", notes: 1 }],
      default_namespace: "dev",
    });
  });

  test("deleting a namespace deletes its notes and its project attachments", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, { namespaces: [{ name: "dev" }] });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    await write(memory, account, P1, "deploy");
    expect(
      await memory.owner(account, { op: "namespace-delete", name: "dev" }),
    ).toEqual({ deleted_notes: 1 });
    const status = await memory.owner(account, { op: "status" });
    expect(status).toMatchObject({ notes: 0, namespaces: [], projects: {} });
    await expect(
      memory.owner(account, {
        op: "set-project-namespaces",
        project_id: P1,
        namespaces: ["dev"],
      }),
    ).rejects.toThrow("no memory namespace named dev");
  });

  test("agents are charged (writes by note size); the owner never is", async () => {
    const { memory, charges, writable } = setup();
    const account = await newAccount(memory);
    expect(charges).toEqual([]);
    await write(memory, account, P1, "deploy", "12345");
    await memory.agent(account, P1, { action: "memory", op: "list" });
    await memory.turnIndex(account, P1);
    expect(charges).toEqual([
      `write:${"the deploy note".length + 5}`,
      "read:0",
      "read:0",
    ]);
    await memory.owner(account, { op: "list" });
    await memory.owner(account, { op: "delete", name: "deploy" });
    expect(charges).toHaveLength(3);
    // Every write path checks the account is writable here (rehome fence).
    expect(writable).toHaveBeenCalled();
  });

  test("a namespace detached during a request cannot be changed by it", async () => {
    const { memory, onceBeforeCharge } = setup();
    const account = await newAccount(memory, { namespaces: [{ name: "dev" }] });
    const attach = (namespaces: string[]) =>
      memory.owner(account, {
        op: "set-project-namespaces",
        project_id: P1,
        namespaces,
      });
    await attach(["dev"]);
    await write(memory, account, P1, "dev/deploy");
    await write(memory, account, P1, "global/prefs");
    for (const request of [
      { action: "memory", op: "delete", name: "deploy" },
      { action: "memory", op: "move", name: "deploy", to: "global" },
      { action: "memory", op: "move", name: "prefs", to: "dev" },
    ] as const) {
      await attach(["dev"]);
      // The owner detaches dev after the request read the settings.
      onceBeforeCharge(() => attach([]));
      const result = await memory
        .agent(account, P1, request as any)
        .catch((err) => err.message);
      expect(result).toEqual(
        request.op === "delete"
          ? { name: "deploy", deleted: false }
          : request.name === "deploy"
            ? "no memory note named deploy"
            : "memory namespace dev is not available in this project",
      );
    }
    expect(
      (await memory.owner(account, { op: "list" })).notes_list.map(
        (n: any) => `${n.namespace}/${n.name}`,
      ),
    ).toEqual(expect.arrayContaining(["dev/deploy", "global/prefs"]));
  });

  test("a project's turn list says nothing about namespaces it does not see", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, {
      namespaces: [{ name: "hidden" }],
    });
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       SELECT $1, 'hidden', 'n-' || i, 'x', 'x', 17000 FROM generate_series(1, 480) AS i`,
      [account],
    );
    // 8.16 MB, all of it hidden from P1: the list stays silent about it.
    const index = (await memory.turnIndex(account, P1))!.index;
    expect(index).toBe("Saved notes: (none yet)");
    // At the account's limit, an agent learns only that there is no room.
    await expect(write(memory, account, P1, "one-more")).rejects.toThrow(
      /^agent memory has no room for this note; the account owner can review and tidy it/,
    );
  });

  test("a move fits when the account is exactly full", async () => {
    const { memory } = setup();
    const account = await newAccount(memory, { namespaces: [{ name: "dev" }] });
    await memory.owner(account, {
      op: "set-project-namespaces",
      project_id: P1,
      namespaces: ["dev"],
    });
    // 499 in dev and 500 in each of three others, then one global note:
    // 2,000, the account's limit.
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       SELECT $1, CASE WHEN i <= 499 THEN 'dev' WHEN i <= 999 THEN 'a'
                       WHEN i <= 1499 THEN 'b' ELSE 'c' END, 'n-' || i, 'x', 'x', 2
         FROM generate_series(1, 1999) AS i`,
      [account],
    );
    await write(memory, account, P1, "global/last");
    expect(
      await memory.agent(account, P1, {
        action: "memory",
        op: "move",
        name: "last",
        to: "dev",
      }),
    ).toEqual({ name: "dev/last", from: "global", to: "dev" });
  });
});
