import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { lockAccountRehomeFence } from "@cocalc/server/accounts/rehome-fence";
import { AgentStore } from "./store";
import { PersonalAgentStore } from "./personal-store";
import {
  assertNoPersonalStateForRehome,
  PERSONAL_AGENT_STATE_TABLES,
} from "./personal-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("personal state rehome guard and canonical write fence", () => {
  const db = new AgentStore();
  const account = randomUUID(),
    other = randomUUID();
  const source = { project_id: randomUUID(), agent_id: randomUUID() };
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const previousBay = process.env.COCALC_BAY_ID;
  const identity = jest.fn(
    async (_a, e) =>
      ({
        ...e,
        path: "/home/user/test.chat",
        thread_id: "thread",
      }) as AgentIdentity,
  );
  const store = new PersonalAgentStore(db, identity, async () => account);
  const grant = () =>
    store.grant(account, {
      source,
      target,
      reason: "review",
      approval_request_id: randomUUID(),
    });
  const guardedRehome = (account_id = account) =>
    db.transaction(async (client) => {
      await lockAccountRehomeFence({ db: client, account_id });
      await assertNoPersonalStateForRehome(client, account_id);
    });
  const startRehome = () =>
    db.query(
      "INSERT INTO account_rehome_operations(op_id,account_id,status,stage,source_bay_id,dest_bay_id) VALUES($1,$2,'running','requested','personal-home','new-home')",
      [randomUUID(), account],
    );

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "personal-home";
    await syncSchema(
      Object.fromEntries(
        PERSONAL_AGENT_STATE_TABLES.map((t) => [t, SCHEMA[t]]),
      ),
    );
    await db.query(
      "CREATE TABLE accounts(account_id uuid PRIMARY KEY,home_bay_id text,deleted boolean)",
    );
    await db.query(
      "CREATE TABLE cluster_account_directory(account_id uuid PRIMARY KEY,home_bay_id text)",
    );
    await db.query(
      "CREATE TABLE account_rehome_operations(op_id uuid PRIMARY KEY,account_id uuid,status text,stage text,source_bay_id text,dest_bay_id text,created_at timestamptz DEFAULT now())",
    );
  });
  afterAll(() => {
    if (previousBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = previousBay;
  });
  beforeEach(async () => {
    for (const table of [
      ...PERSONAL_AGENT_STATE_TABLES,
      "accounts",
      "cluster_account_directory",
      "account_rehome_operations",
    ])
      await db.query(`DELETE FROM ${table}`);
    await db.query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,'personal-home'),($2,'personal-home')",
      [account, other],
    );
    identity.mockClear();
  });

  test("inventory covers every personal table; empty accounts may still rehome", async () => {
    expect([...PERSONAL_AGENT_STATE_TABLES].sort()).toEqual(
      Object.keys(SCHEMA)
        .filter((t) => t.startsWith("agent_personal_"))
        .sort(),
    );
    await expect(guardedRehome()).resolves.toBeUndefined();
  });

  test.each(PERSONAL_AGENT_STATE_TABLES)(
    "retained %s state blocks rehome",
    async (table) => {
      if (table === "agent_personal_names") {
        await store.name(account, { endpoint: source, name: "old-name" });
        await store.name(account, { endpoint: source, name: "new-name" });
        await db.query(
          "DELETE FROM agent_personal_names WHERE name='new-name'",
        );
      } else if (table === "agent_personal_grants") {
        const [link] = await grant();
        await store.setConnection(account, {
          direction_group_id: link.direction_group_id,
          state: "revoked",
        });
      } else if (table === "agent_personal_requests") {
        const request = await store.request(account, {
          source,
          target,
          run_id: randomUUID(),
          request_id: randomUUID(),
          reason: "review",
        });
        await store.resolveRequest(account, request.request_id, "deny");
      } else await store.setControls(account, { action: "revoke_all" });
      if (table !== "agent_personal_controls")
        await db.query("DELETE FROM agent_personal_controls");
      await expect(guardedRehome()).rejects.toThrow(
        "Personal agent state portability is not supported yet",
      );
      await expect(guardedRehome(other)).resolves.toBeUndefined();
      expect(
        (
          await db.query(`SELECT * FROM ${table} WHERE account_id=$1`, [
            account,
          ])
        ).rows,
      ).toHaveLength(1);
    },
  );

  test("running rehome fences first writes and authority reads without inserting controls", async () => {
    await startRehome();
    await expect(store.assertHome(account)).rejects.toThrow("account rehome");
    await expect(
      store.name(account, { endpoint: source, name: "blocked" }),
    ).rejects.toThrow("account rehome");
    await expect(grant()).rejects.toThrow("account rehome");
    await expect(store.check(account, source, target, false)).rejects.toThrow(
      "account rehome",
    );
    for (const table of PERSONAL_AGENT_STATE_TABLES)
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  });

  test.each(["accounts", "cluster_account_directory"])(
    "stale home writes and grant checks reject after %s ownership changes",
    async (table) => {
      const [link] = await grant();
      if (table === "accounts")
        await db.query(
          "UPDATE accounts SET home_bay_id='new-home' WHERE account_id=$1",
          [account],
        );
      else
        await db.query(
          "INSERT INTO cluster_account_directory VALUES($1,'new-home')",
          [account],
        );
      await expect(store.assertHome(account)).rejects.toThrow(
        "account is homed on new-home",
      );
      await expect(
        store.setControls(account, { action: "revoke_all" }),
      ).rejects.toThrow("account is homed on new-home");
      await expect(store.observe(account, link.link_id, true)).rejects.toThrow(
        "account is homed on new-home",
      );
      await expect(store.check(account, source, target, false)).rejects.toThrow(
        "account is homed on new-home",
      );
      expect(
        (
          await db.query(
            "SELECT generation FROM agent_personal_controls WHERE account_id=$1",
            [account],
          )
        ).rows,
      ).toEqual([{ generation: 0 }]);
      expect(
        (await db.query("SELECT last_attempt_at FROM agent_personal_grants"))
          .rows,
      ).toEqual([{ last_attempt_at: null }]);
    },
  );

  test("rehome starting during remote endpoint validation is rechecked inside the mutation fence", async () => {
    await store.assertHome(account);
    identity.mockImplementationOnce(async (_a, e) => {
      await startRehome();
      return {
        ...e,
        path: "/home/user/test.chat",
        thread_id: "thread",
      } as AgentIdentity;
    });
    await expect(
      store.name(account, { endpoint: source, name: "blocked" }),
    ).rejects.toThrow("account rehome");
    expect(
      (await db.query("SELECT * FROM agent_personal_names")).rows,
    ).toHaveLength(0);
  });

  test("older deployments with no personal tables still allow rehome", async () => {
    await db.transaction(async (client) => {
      for (const table of PERSONAL_AGENT_STATE_TABLES)
        await client.query(
          `ALTER TABLE ${table} RENAME TO test_hidden_${table}`,
        );
      try {
        await assertNoPersonalStateForRehome(client, account);
      } finally {
        for (const table of PERSONAL_AGENT_STATE_TABLES)
          await client.query(
            `ALTER TABLE test_hidden_${table} RENAME TO ${table}`,
          );
      }
    });
  });
});
