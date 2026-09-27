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

describeDb("Agent Network account rehome fence", () => {
  let db: AgentStore;
  const tables = [
    ...PERSONAL_AGENT_STATE_TABLES,
    ...EXTERNAL_AGENT_STATE_TABLES,
  ];
  beforeAll(async () => {
    db = new AgentStore();
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

  test("the inventory contains no retired directional authority tables", () => {
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_networks",
        "agent_network_proposals",
        "agent_network_broadcasts",
        "agent_external_inbox",
        "collaboration_personal",
        "collaboration_artifact_bindings",
      ]),
    );
    expect(tables).not.toContain("agent_personal_grants");
    expect(tables).not.toContain("agent_personal_requests");
  });

  test("collaboration aliases and attention remain protected with the feature disabled", async () => {
    const account = randomUUID();
    await db.query(
      "INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias) VALUES($1,$2,$3,'seminar')",
      [account, "collaboration-test", randomUUID()],
    );
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "Account rehome is unavailable",
    );
  });
});
