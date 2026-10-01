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
      Object.fromEntries(
        [
          ...tables,
          "collaboration_personal",
          "collaboration_artifact_bindings",
        ].map((name) => [name, SCHEMA[name]]),
      ),
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
      ]),
    );
    expect(tables).not.toContain("agent_personal_grants");
    expect(tables).not.toContain("agent_personal_requests");
    expect(tables).not.toContain("collaboration_personal");
    expect(tables).not.toContain("collaboration_artifact_bindings");
  });

  test("portable collaboration aliases no longer trip the unrelated agent guard", async () => {
    const account = randomUUID();
    await db.query(
      "INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias) VALUES($1,$2,$3,'seminar')",
      [account, "collaboration-test", randomUUID()],
    );
    await expect(
      assertNoPersonalStateForRehome(db, account),
    ).resolves.toBeUndefined();
  });

  test("native Library state still blocks rehome alongside portable collaboration state", async () => {
    const account = randomUUID();
    await db.query(
      "INSERT INTO collaboration_artifact_bindings(account_id,entry_key,project_id,entry_id) VALUES($1,'binding',$2,'entry')",
      [account, randomUUID()],
    );
    await expect(
      assertNoPersonalStateForRehome(db, account),
    ).resolves.toBeUndefined();
    await db.query(
      "INSERT INTO personal_library_controls(account_id) VALUES($1)",
      [account],
    );
    await expect(assertNoPersonalStateForRehome(db, account)).rejects.toThrow(
      "Account rehome is unavailable",
    );
  });
});
