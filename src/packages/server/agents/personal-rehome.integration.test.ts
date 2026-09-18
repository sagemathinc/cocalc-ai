import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AgentStore } from "./store";
import {
  EXTERNAL_AGENT_STATE_TABLES,
  PERSONAL_AGENT_STATE_TABLES,
  assertNoPersonalStateForRehome,
} from "./personal-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("Agent Session account rehome fence", () => {
  const db = new AgentStore();
  const tables = [
    ...PERSONAL_AGENT_STATE_TABLES,
    ...EXTERNAL_AGENT_STATE_TABLES,
  ];
  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });

  test("every retained account-home session table participates in the fence", async () => {
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

  test("the inventory contains no retired directional authority tables", () => {
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_sessions",
        "agent_session_proposals",
        "agent_session_broadcasts",
        "agent_external_inbox",
      ]),
    );
    expect(tables).not.toContain("agent_personal_grants");
    expect(tables).not.toContain("agent_personal_requests");
  });
});
