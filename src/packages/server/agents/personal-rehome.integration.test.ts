import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AgentStore } from "./store";
import {
  COMPUTER_STATE_TABLES,
  EXTERNAL_AGENT_STATE_TABLES,
  PERSONAL_AGENT_STATE_TABLES,
  assertNoPersonalStateForRehome,
} from "./personal-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("Agent Network account rehome fence", () => {
  const db = new AgentStore();
  const tables = [
    ...PERSONAL_AGENT_STATE_TABLES,
    ...EXTERNAL_AGENT_STATE_TABLES,
    ...COMPUTER_STATE_TABLES,
  ];
  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });

  test("every retained account-home network table participates in the fence", async () => {
    const account = randomUUID();
    await expect(
      assertNoPersonalStateForRehome(db, account),
    ).resolves.toBeUndefined();
    await db.query(
      "INSERT INTO agent_personal_controls(account_id) VALUES($1)",
      [account],
    );
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "Account rehome is unavailable",
    );
  });

  test("computers, their pairing requests and their audit block rehome", async () => {
    const queried: string[] = [];
    await assertNoPersonalStateForRehome(
      {
        query: async (sql: string, values?: unknown[]) => {
          queried.push(sql);
          return await db.query(sql, values);
        },
      },
      randomUUID(),
    );
    for (const table of COMPUTER_STATE_TABLES) {
      expect(queried.some((sql) => sql.includes(`"${table}"`))).toBe(true);
    }
    const account = randomUUID();
    await db.query(
      `INSERT INTO account_computer_requests
         (request_id, account_id, name, requested_policy, state, server_nonce, expires_at, agent_network_id)
       VALUES ('R-REHOME0001', $1, 'mac', '{}', 'declined', 'n', now(), $2)`,
      [account, randomUUID()],
    );
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "computers",
    );
  });

  test("the inventory contains no retired directional authority tables", () => {
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_networks",
        "agent_network_proposals",
        "agent_network_broadcasts",
        "agent_external_inbox",
      ]),
    );
    expect(tables).not.toContain("agent_personal_grants");
    expect(tables).not.toContain("agent_personal_requests");
  });

  test.each(["conversation", "person", "project"])(
    "retained People %s state blocks rehome, including default-only rows",
    async (kind) => {
      const account = randomUUID();
      await expect(
        assertNoPersonalStateForRehome(db, account),
      ).resolves.toBeUndefined();
      await db.query(
        "INSERT INTO account_people_state(account_id, kind, target_id) VALUES($1, $2, $3)",
        [account, kind, randomUUID()],
      );
      await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
        "People state",
      );
      await expect(
        assertNoPersonalStateForRehome(db, randomUUID()),
      ).resolves.toBeUndefined();
    },
  );
});
