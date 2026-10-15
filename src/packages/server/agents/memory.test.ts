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
import {
  AGENT_MEMORY_DISABLED,
  createAgentMemory,
  defaultAgentMemoryDeps,
} from "./memory";

// Identity "encryption" for the default first-version reader.
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  decryptSecretStorageValue: async (_aad: string, value: string) => ({
    value,
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const P1 = randomUUID();
const P2 = randomUUID();
const P3 = randomUUID();

// The first version's record, with a version that changes on every write.
class LegacyStore {
  records = new Map<string, { payload: string; version: string }>();
  reads: ("transaction" | "pool")[] = [];
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
  let encryptGate: { text: string; wait: Promise<void> } | undefined;
  const charges: string[] = [];
  const writable = jest.fn(async () => {});
  const memory = createAgentMemory({
    pool: () => getPool() as any,
    // Bound to the note's place, like the real cipher's associated data.
    encrypt: async (aad, text) => {
      if (encryptGate && text === encryptGate.text) await encryptGate.wait;
      return `enc:${aad}:${Buffer.from(text).toString("base64")}`;
    },
    decrypt: async (aad, value) => {
      const prefix = `enc:${aad}:`;
      if (!value.startsWith(prefix)) throw new Error("wrong associated data");
      return Buffer.from(value.slice(prefix.length), "base64").toString();
    },
    legacy: {
      get: async (account_id, db) => {
        legacy.reads.push(db ? "transaction" : "pool");
        return legacy.records.get(account_id);
      },
      remove: async (account_id) => {
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
    /** Holds encrypting this text until the returned function is called. */
    holdEncrypting: (text: string) => {
      let release!: () => void;
      encryptGate = { text, wait: new Promise<void>((r) => (release = r)) };
      return () => {
        encryptGate = undefined;
        release();
      };
    },
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
      agent_memory_agents: SCHEMA.agent_memory_agents,
      agent_personal_names: SCHEMA.agent_personal_names,
      external_credentials: SCHEMA.external_credentials,
    });
  });

  test("the first-version record is read from the credentials table", async () => {
    const account = randomUUID();
    const read = () => defaultAgentMemoryDeps.legacy.get(account);
    expect(await read()).toBeUndefined();
    await getPool().query(
      `INSERT INTO external_credentials (id, provider, kind, scope, owner_account_id, encrypted_payload, metadata, created, updated)
       VALUES ($1, 'cocalc', 'agent-memory', 'account', $2, $3, '{}'::jsonb, now(), now())`,
      [randomUUID(), account, '{"version":1,"enabled":true,"notes":[]}'],
    );
    const record = await read();
    expect(record?.payload).toBe('{"version":1,"enabled":true,"notes":[]}');
    expect(record?.version).toMatch(/^[0-9a-f]{64}$/);
    await defaultAgentMemoryDeps.legacy.remove(account);
    expect(await read()).toBeUndefined();
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
      revision: expect.stringMatching(/^[0-9a-f]{16}$/),
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

  test("the first version's record is absorbed into rows and kept for now", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    const prefs = {
      name: "prefs",
      description: "Preferences",
      body: "Be brief.",
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    const deploy = {
      name: "deploy",
      description: "Deploy",
      body: "Use a terminal.",
      updated_at: "2026-10-02T00:00:00.000Z",
    };
    legacy.set(
      account,
      JSON.stringify({ version: 1, enabled: true, notes: [prefs, deploy] }),
    );
    const index = await memory.turnIndex(account, P1);
    expect(index?.notes).toBe(2);
    expect(index?.index).toContain("- deploy: Deploy");
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
    // Kept: a hub still on the first version may write it, and deleting it
    // under such a writer would lose that write.
    expect(legacy.has(account)).toBe(true);
    // A note deleted here does not come back from the unchanged record.
    await memory.owner(account, { op: "delete", name: "deploy" });
    expect((await memory.owner(account, { op: "status" })).notes).toBe(1);
  });

  test("rolling upgrade: an old hub's write after the move is absorbed", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    const record = (notes: any[]) =>
      JSON.stringify({ version: 1, enabled: true, notes });
    const old = {
      name: "old",
      description: "Old",
      body: "from before",
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    legacy.set(
      account,
      record([
        old,
        { ...old, name: "deploy", description: "Deploy", body: "before" },
      ]),
    );
    await memory.turnIndex(account, P1);
    await memory.owner(account, { op: "delete", name: "old" });
    // An old hub, having read the record before, writes it: it changes
    // deploy and adds a note; the note deleted here is still in it.
    const now = new Date().toISOString();
    legacy.set(
      account,
      record([
        old,
        {
          ...old,
          name: "deploy",
          description: "Deploy",
          body: "after",
          updated_at: now,
        },
        {
          ...old,
          name: "late",
          description: "Late",
          body: "new",
          updated_at: now,
        },
      ]),
    );
    const notes = (await memory.owner(account, { op: "list" })).notes_list
      .map((n: any) => n.name)
      .sort();
    expect(notes).toEqual(["deploy", "late"]);
    const deploy: any = await memory.agent(account, P1, {
      action: "memory",
      op: "read",
      name: "deploy",
    });
    expect(deploy.body).toBe("after");
    // The owner's on/off setting here is not taken from a later record.
    legacy.set(
      account,
      JSON.stringify({ version: 1, enabled: false, notes: [] }),
    );
    expect((await memory.owner(account, { op: "status" })).enabled).toBe(true);
  });

  test("a recent note deleted here stays deleted when an old hub rewrites the record", async () => {
    const { memory, legacy } = setup();
    const account = randomUUID();
    const recent = {
      name: "recent",
      description: "Recent",
      body: "written a second before the move",
      updated_at: new Date(Date.now() - 1000).toISOString(),
    };
    legacy.set(
      account,
      JSON.stringify({ version: 1, enabled: true, notes: [recent] }),
    );
    await memory.owner(account, { op: "status" });
    await memory.owner(account, { op: "delete", name: "recent" });
    // The old hub writes its cached record: the deleted note unchanged, and
    // a genuinely new note.
    legacy.set(
      account,
      JSON.stringify({
        version: 1,
        enabled: true,
        notes: [
          recent,
          {
            ...recent,
            name: "late",
            body: "new",
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(
      (await memory.owner(account, { op: "list" })).notes_list.map(
        (n: any) => n.name,
      ),
    ).toEqual(["late"]);
  });

  test("an absorb of an older record that finishes last does not undo a newer one", async () => {
    const { memory, legacy, holdEncrypting } = setup();
    const account = randomUUID();
    const record = (body: string) =>
      JSON.stringify({
        version: 1,
        enabled: true,
        notes: [
          {
            name: "deploy",
            description: "Deploy",
            body,
            updated_at: new Date().toISOString(),
          },
        ],
      });
    legacy.set(account, record("p1"));
    await memory.owner(account, { op: "status" });
    // A reads the record (p2) and stalls before its transaction...
    legacy.set(account, record("p2"));
    const release = holdEncrypting("p2");
    const a = memory.owner(account, { op: "list" });
    await new Promise((r) => setTimeout(r, 20));
    // ...meanwhile an old hub writes p3, B absorbs it, the owner deletes it.
    legacy.set(account, record("p3"));
    await memory.owner(account, { op: "status" });
    await memory.owner(account, { op: "delete", name: "deploy" });
    release();
    expect((await a).notes_list).toEqual([]);
    // Under the lock, the record is re-read on the transaction's own
    // connection, never a second one from the pool.
    expect(legacy.reads).toContain("transaction");
    expect((await memory.owner(account, { op: "list" })).notes_list).toEqual(
      [],
    );
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
    // With namespaces in view, global notes are named in full too.
    expect((await write(memory, account, P1, "global/prefs")).name).toBe(
      "global/prefs",
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
      "global/prefs",
      "dev/deploy",
      "math/theorem",
    ]);
    // An existing note is updated where it is, not copied into a namespace.
    expect(await write(memory, account, P1, "prefs", "v2")).toEqual({
      name: "global/prefs",
      namespace: "global",
      saved: "updated",
      revision: expect.stringMatching(/^[0-9a-f]{16}$/),
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
    expect(index).toContain("- global/prefs: the prefs note");
    expect(index.indexOf("- dev/written-here")).toBeLessThan(
      index.indexOf("- dev/written-elsewhere"),
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
      limits: {
        account_notes: 2000,
        namespace_notes: 500,
        description_bytes: 200,
        body_bytes: 8000,
      },
    });
  });

  test("a write with the revision it read refuses to replace a later change", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await write(memory, account, P1, "deploy", "v1");
    const read = (): Promise<any> =>
      memory.agent(account, P1, {
        action: "memory",
        op: "read",
        name: "deploy",
      });
    const writeIf = (body: string, expected_revision: string) =>
      memory.agent(account, P1, {
        action: "memory",
        op: "write",
        name: "deploy",
        description: "the deploy note",
        body,
        expected_revision,
      }) as Promise<any>;
    const mine = (await read()).revision;
    expect(mine).toMatch(/^[0-9a-f]{16}$/);
    // Another agent changes the note in between.
    const theirs = (await write(memory, account, P1, "deploy", "v2")).revision;
    expect(theirs).not.toBe(mine);
    expect((await read()).revision).toBe(theirs);
    await expect(writeIf("v3", mine)).rejects.toThrow(
      "memory note deploy changed since you read it; read it again and merge your change",
    );
    expect((await read()).body).toBe("v2");
    expect(await writeIf("v3", theirs)).toMatchObject({ saved: "updated" });
    // Nor does it bring back a note deleted since the read.
    const last = (await read()).revision;
    await memory.agent(account, P1, {
      action: "memory",
      op: "delete",
      name: "deploy",
    });
    await expect(writeIf("v4", last)).rejects.toThrow(
      "memory note deploy no longer exists",
    );
    expect(await names(memory, account, P1)).toEqual([]);
    // Deleting a note that is not there is an error, not a quiet success.
    await expect(
      memory.agent(account, P1, {
        action: "memory",
        op: "delete",
        name: "deploy",
      }),
    ).rejects.toThrow("no memory note named deploy");
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
        request.name === "deploy"
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

describeDb("agent memory: authorship, agent scopes and expiry", () => {
  const OPS = { agent_id: randomUUID(), name: "ops3" };
  const REVIEW = { agent_id: randomUUID(), name: "review" };

  beforeAll(async () => {
    await syncSchema({
      agent_memory_accounts: SCHEMA.agent_memory_accounts,
      agent_memory_notes: SCHEMA.agent_memory_notes,
      agent_memory_agents: SCHEMA.agent_memory_agents,
      agent_personal_names: SCHEMA.agent_personal_names,
      external_credentials: SCHEMA.external_credentials,
    });
  });

  const as = (
    memory: ReturnType<typeof setup>["memory"],
    account: string,
    agent: { agent_id: string; name: string } | undefined,
    request: Record<string, unknown>,
  ) =>
    memory.agent(
      account,
      P1,
      { action: "memory", ...request } as any,
      agent,
    ) as Promise<any>;

  const note = (name: string, body = `about ${name}`, extra = {}) => ({
    op: "write",
    name,
    description: `the ${name.split("/").pop()} note`,
    body,
    ...extra,
  });

  test("another agent's note is replaced or removed only with the revision it read", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("pr1098-status", "ops3 working notes"));
    // Overwriting blind fails and names the writer.
    await expect(
      as(memory, account, REVIEW, note("pr1098-status", "review verdict")),
    ).rejects.toThrow(/last written by @ops3; to replace it, read it/);
    await expect(
      as(memory, account, REVIEW, { op: "delete", name: "pr1098-status" }),
    ).rejects.toThrow(/last written by @ops3; to delete it/);
    // After a read, with its revision, it works and records the new writer.
    const read = await as(memory, account, REVIEW, {
      op: "read",
      name: "pr1098-status",
    });
    expect(read.written_by).toBe("ops3");
    await as(
      memory,
      account,
      REVIEW,
      note("pr1098-status", "merged view", {
        expected_revision: read.revision,
      }),
    );
    // The writer may always change its own note.
    await expect(
      as(memory, account, REVIEW, note("pr1098-status", "again")),
    ).resolves.toMatchObject({ saved: "updated" });
    // Notes from before authorship was kept are not guarded.
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       VALUES ($1, 'global', 'legacy', $2, $3, 2)`,
      [
        account,
        "enc:agent-memory:" +
          account +
          ":global:legacy:description:" +
          Buffer.from("old").toString("base64"),
        "enc:agent-memory:" +
          account +
          ":global:legacy:body:" +
          Buffer.from("old").toString("base64"),
      ],
    );
    await expect(
      as(memory, account, OPS, note("legacy", "new")),
    ).resolves.toMatchObject({ saved: "updated" });
  });

  test("an agent's own scope: listed first for it, read-only for others", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("shared-fact"));
    const saved = await as(memory, account, OPS, note("agent/waiting-on"));
    expect(saved).toMatchObject({
      name: "agent/waiting-on",
      namespace: "agent",
      saved: "created",
    });
    // Own scope notes expire by default, 30 days out.
    const days =
      (Date.parse(saved.expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const own = (await memory.turnIndex(account, P1, OPS))!.index;
    expect(own).toContain("Your own scope: agent/<name>");
    expect(own.indexOf("- agent/waiting-on:")).toBeLessThan(
      own.indexOf("- shared-fact:"),
    );
    // Another agent's list shows only shared notes, with their writer.
    const other = (await memory.turnIndex(account, P1, REVIEW))!.index;
    expect(other).not.toContain("waiting-on");
    expect(other).toContain("- shared-fact: the shared-fact note (by @ops3)");
    // ...but it can read the scope as @ops3/..., and not change it.
    await expect(
      as(memory, account, REVIEW, { op: "read", name: "@ops3/waiting-on" }),
    ).resolves.toMatchObject({
      name: "@ops3/waiting-on",
      namespace: "@ops3",
      body: "about agent/waiting-on",
    });
    const listed = await as(memory, account, REVIEW, {
      op: "list",
      namespace: "@ops3",
    });
    expect(listed.notes.map((n: any) => n.name)).toEqual(["@ops3/waiting-on"]);
    await expect(
      as(memory, account, REVIEW, note("@ops3/waiting-on", "hijack")),
    ).rejects.toThrow(/belong to @ops3/);
    await expect(
      as(memory, account, REVIEW, { op: "delete", name: "@ops3/waiting-on" }),
    ).rejects.toThrow(/belong to @ops3/);
    // A turn without a registered agent has no own scope.
    await expect(
      as(memory, account, undefined, note("agent/x")),
    ).rejects.toThrow(/registered agent identity/);
    // The same name in the own scope and globally does not collide.
    await as(memory, account, OPS, note("agent/shared-fact"));
    const both = await as(memory, account, OPS, { op: "list" });
    expect(both.notes.map((n: any) => n.name)).toEqual(
      expect.arrayContaining(["agent/shared-fact", "shared-fact"]),
    );
  });

  test("an agent is named as the account names it", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const agent = { agent_id: randomUUID(), name: "Registered Display Name" };
    await getPool().query(
      `INSERT INTO agent_personal_names (account_id, name, project_id, agent_id, metadata, created_at, updated_at)
       VALUES ($1, 'helper', $2, $3, '{}'::jsonb, now(), now())`,
      [account, P1, agent.agent_id],
    );
    await as(memory, account, agent, note("shared"));
    const read = await as(memory, account, OPS, { op: "read", name: "shared" });
    expect(read.written_by).toBe("helper");
    await as(memory, account, agent, note("agent/mine"));
    await expect(
      as(memory, account, OPS, { op: "read", name: "@helper/mine" }),
    ).resolves.toMatchObject({ name: "@helper/mine" });
  });

  test("each agent's own scope has its own limit", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("agent/first"));
    await getPool().query(
      `INSERT INTO agent_memory_notes (account_id, namespace, name, description, body, bytes)
       SELECT $1, $2, 'n-' || i, 'x', 'x', 2 FROM generate_series(1, 99) AS i`,
      [account, `agent:${OPS.agent_id}`],
    );
    await expect(
      as(memory, account, OPS, note("agent/one-more")),
    ).rejects.toThrow(/already has 100 notes in your own scope/);
    // Other agents and shared notes are unaffected.
    await as(memory, account, REVIEW, note("agent/fine"));
    await as(memory, account, OPS, note("shared-fine"));
  });

  test("expiry: hidden once past, pushed out by use, never for promoted notes", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const expire = (name: string, namespace = `agent:${OPS.agent_id}`) =>
      getPool().query(
        `UPDATE agent_memory_notes SET expires_at = now() - interval '1 second'
          WHERE account_id=$1 AND namespace=$2 AND name=$3`,
        [account, namespace, name],
      );
    await as(memory, account, OPS, note("agent/old"));
    await expire("old");
    // An expired note acts as deleted: not listed, not readable, name free.
    expect(
      (await as(memory, account, OPS, { op: "list" })).notes.map(
        (n: any) => n.name,
      ),
    ).not.toContain("agent/old");
    await expect(
      as(memory, account, OPS, { op: "read", name: "agent/old" }),
    ).rejects.toThrow(/no memory note/);
    await expect(
      as(memory, account, OPS, note("agent/old", "fresh")),
    ).resolves.toMatchObject({ saved: "created" });

    // A shared note can expire on request, and reading it pushes it out.
    const saved = await as(
      memory,
      account,
      OPS,
      note("short-lived", "x", { expires_in: "2h" }),
    );
    const hours = (Date.parse(saved.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
    await getPool().query(
      `UPDATE agent_memory_notes SET expires_at = now() + interval '1 minute'
        WHERE account_id=$1 AND name='short-lived'`,
      [account],
    );
    const read = await as(memory, account, OPS, {
      op: "read",
      name: "short-lived",
    });
    expect(
      (Date.parse(read.expires_at) - Date.now()) / 3_600_000,
    ).toBeGreaterThan(1.9);
    // An update without --expires keeps the note's expiry; never clears it.
    expect(
      (await as(memory, account, OPS, note("short-lived", "y"))).expires_at,
    ).toBeDefined();
    expect(
      (
        await as(
          memory,
          account,
          OPS,
          note("short-lived", "z", { expires_in: "never" }),
        )
      ).expires_at,
    ).toBeUndefined();
    // Promoting an own note to shared memory keeps it until deleted.
    await as(memory, account, OPS, note("agent/lesson"));
    await as(memory, account, OPS, {
      op: "move",
      name: "agent/lesson",
      to: "global",
    });
    const promoted = await as(memory, account, OPS, {
      op: "read",
      name: "lesson",
    });
    expect(promoted.expires_at).toBeUndefined();
  });

  test("the sweep deletes expired notes and scopes of long-idle agents only", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const idle = { agent_id: randomUUID(), name: "idle" };
    await as(memory, account, idle, note("agent/stale"));
    await as(
      memory,
      account,
      idle,
      note("agent/pinned", "x", { expires_in: "never" }),
    );
    await as(memory, account, idle, note("shared-by-idle"));
    await as(memory, account, OPS, note("agent/active"));
    await as(memory, account, OPS, note("agent/expired"));
    await getPool().query(
      `UPDATE agent_memory_notes SET expires_at = now() - interval '1 second'
        WHERE account_id=$1 AND name='expired'`,
      [account],
    );
    await getPool().query(
      `UPDATE agent_memory_agents SET last_turn_at = now() - interval '91 days'
        WHERE account_id=$1 AND agent_id=$2`,
      [account, idle.agent_id],
    );
    const swept = await memory.sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(swept.inactive_notes).toBeGreaterThanOrEqual(2);
    const { rows } = await getPool().query(
      "SELECT namespace, name FROM agent_memory_notes WHERE account_id=$1 ORDER BY name",
      [account],
    );
    expect(rows.map((r: any) => r.name)).toEqual(["active", "shared-by-idle"]);
  });

  test("a write by a hub that does not keep authorship drops it and its expiry", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("status", "x", { expires_in: "1h" }));
    // What an older hub does during a rolling upgrade: content and time only.
    await getPool().query(
      `UPDATE agent_memory_notes SET body=$2, description=$3, updated_at=now() + interval '1 second',
              expires_at=now() - interval '1 second'
        WHERE account_id=$1 AND name='status'`,
      [
        account,
        `enc:agent-memory:${account}:global:status:body:` +
          Buffer.from("old hub").toString("base64"),
        `enc:agent-memory:${account}:global:status:description:` +
          Buffer.from("old").toString("base64"),
      ],
    );
    const read = await as(memory, account, REVIEW, {
      op: "read",
      name: "status",
    });
    // Still there (the expiry no longer applies), with no claimed writer...
    expect(read).toMatchObject({ body: "old hub" });
    expect(read.written_by).toBeUndefined();
    expect(read.expires_at).toBeUndefined();
    // ...so it is not guarded on behalf of the former writer.
    await expect(
      as(memory, account, REVIEW, note("status", "review")),
    ).resolves.toMatchObject({ saved: "updated" });
    expect(
      (await as(memory, account, OPS, { op: "read", name: "status" }))
        .written_by,
    ).toBe("review");
  });

  test("a first-version record absorbed later clears authorship and expiry", async () => {
    const { memory, legacy } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("prefs", "x", { expires_in: "2h" }));
    legacy.set(
      account,
      JSON.stringify({
        version: 1,
        enabled: true,
        notes: [
          {
            name: "prefs",
            description: "the prefs note",
            body: "from an old hub",
            updated_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      }),
    );
    const read = await as(memory, account, REVIEW, {
      op: "read",
      name: "prefs",
    });
    expect(read).toMatchObject({ body: "from an old hub" });
    expect(read.written_by).toBeUndefined();
    expect(read.expires_at).toBeUndefined();
  });

  test("turning memory off pauses expiry and inactivity", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const idle = { agent_id: randomUUID(), name: "idle" };
    await as(
      memory,
      account,
      idle,
      note("agent/pinned", "x", { expires_in: "never" }),
    );
    await as(
      memory,
      account,
      OPS,
      note("agent/short", "x", { expires_in: "1h" }),
    );
    await memory.owner(account, { op: "set-enabled", enabled: false });
    await getPool().query(
      `UPDATE agent_memory_notes SET expires_at = now() - interval '1 second'
        WHERE account_id=$1 AND name='short'`,
      [account],
    );
    await getPool().query(
      `UPDATE agent_memory_agents SET last_turn_at = now() - interval '91 days'
        WHERE account_id=$1`,
      [account],
    );
    await memory.sweep();
    // Nothing was deleted, and the owner still sees both.
    const listed = await memory.owner(account, { op: "list" });
    expect(listed.notes_list.map((n: any) => n.name).sort()).toEqual([
      "pinned",
      "short",
    ]);
    // Turning it on again starts the clocks over.
    await memory.owner(account, { op: "set-enabled", enabled: true });
    await memory.sweep();
    const after = await as(memory, account, OPS, {
      op: "read",
      name: "agent/short",
    });
    expect(Date.parse(after.expires_at)).toBeGreaterThan(
      Date.now() + 50 * 60_000,
    );
    await expect(
      as(memory, account, OPS, { op: "read", name: "@idle/pinned" }),
    ).resolves.toMatchObject({ body: "x" });
  });

  test("agents the account does not name get unique names, and @name never guesses", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const first = { agent_id: randomUUID(), name: "Helper" };
    const second = { agent_id: randomUUID(), name: "helper" };
    await as(memory, account, first, note("agent/a"));
    const saved = await as(memory, account, second, note("shared-b"));
    expect(saved.saved).toBe("created");
    const { rows } = await getPool().query(
      "SELECT agent_id, name FROM agent_memory_agents WHERE account_id=$1",
      [account],
    );
    const names = new Map(rows.map((r: any) => [r.agent_id, r.name]));
    expect(names.get(first.agent_id)).toBe("helper");
    const secondName = names.get(second.agent_id)!;
    expect(secondName).toMatch(/^helper-[0-9a-f]{8}$/);
    // The suffixed name is stable on later turns.
    await as(memory, account, second, note("shared-c"));
    expect(
      (await as(memory, account, OPS, { op: "read", name: "shared-c" }))
        .written_by,
    ).toBe(secondName);
    await expect(
      as(memory, account, OPS, { op: "read", name: "@helper/a" }),
    ).resolves.toMatchObject({ name: "@helper/a" });
    // If two agents ever share a name, @name refuses to pick one.
    await getPool().query(
      "UPDATE agent_memory_agents SET name='helper' WHERE account_id=$1",
      [account],
    );
    await expect(
      as(memory, account, OPS, { op: "read", name: "@helper/a" }),
    ).rejects.toThrow(/more than one agent is known as @helper/);
  });

  test("the owner's read follows expiry like an agent's", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    const namespace = `agent:${OPS.agent_id}`;
    await as(
      memory,
      account,
      OPS,
      note("agent/kept", "x", { expires_in: "2h" }),
    );
    await getPool().query(
      `UPDATE agent_memory_notes SET expires_at = now() + interval '1 minute'
        WHERE account_id=$1 AND name='kept'`,
      [account],
    );
    const read = await memory.owner(account, {
      op: "read",
      namespace,
      name: "kept",
    });
    expect(Date.parse(read.expires_at)).toBeGreaterThan(
      Date.now() + 100 * 60_000,
    );
    await getPool().query(
      `UPDATE agent_memory_notes SET expires_at = now() - interval '1 second'
        WHERE account_id=$1 AND name='kept'`,
      [account],
    );
    await expect(
      memory.owner(account, { op: "read", namespace, name: "kept" }),
    ).rejects.toThrow(/no memory note/);
  });

  test("removing an agent from Agents deletes its own scope and nothing else", async () => {
    const { memory } = setup();
    const account = await newAccount(memory);
    await as(memory, account, OPS, note("agent/mine"));
    await as(memory, account, OPS, note("shared-mine"));
    await as(memory, account, REVIEW, note("agent/theirs"));
    expect(await memory.agentRetired(account, OPS.agent_id)).toEqual({
      deleted: 1,
    });
    const { rows } = await getPool().query(
      "SELECT name FROM agent_memory_notes WHERE account_id=$1 ORDER BY name",
      [account],
    );
    expect(rows.map((r: any) => r.name)).toEqual(["shared-mine", "theirs"]);
    const status = await memory.owner(account, { op: "status" });
    expect(status.agents).toEqual([
      { agent_id: REVIEW.agent_id, name: "review", notes: 1 },
    ]);
  });
});
