import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AgentStore } from "./store";
import { cleanupAgentMessagingHistory } from "./maintenance";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("Agent Session retention", () => {
  const db = new AgentStore();
  const tables = [
    "agent_rpc_admission_state",
    "agent_session_mutations",
    "agent_session_activity",
    "agent_session_proposals",
    "agent_session_broadcasts",
    "agent_external_inbox",
  ];
  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
    await db.query(`CREATE TABLE IF NOT EXISTS agent_identity_runs(
      agent_id uuid,run_id uuid,ended_at timestamptz,expires_at timestamptz)`);
    await db.query(`CREATE TABLE IF NOT EXISTS agent_external_installations(
      installation_id uuid PRIMARY KEY,state text,created_at timestamptz,expires_at timestamptz)`);
  });
  beforeEach(async () => {
    for (const table of tables) await db.query(`DELETE FROM ${table}`);
  });

  test("removes expired bounded coordination state", async () => {
    const account = randomUUID();
    await db.query(
      `INSERT INTO agent_session_mutations
       (account_id,request_id,binding_hash,agent_session_id,created_at)
       VALUES($1,$2,'hash',$3,now()-interval '31 days')`,
      [account, randomUUID(), randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_session_proposals
       (proposal_id,account_id,source,delivery_mode,members,state,binding_hash,expires_at)
       VALUES($1,$2,$3,'queued',$4,'expired','hash',now()-interval '31 days')`,
      [
        randomUUID(),
        account,
        { project_id: randomUUID(), agent_id: randomUUID() },
        [],
      ],
    );
    const result = await cleanupAgentMessagingHistory();
    expect(result.session_mutations).toBe(1);
    expect(result.session_proposals).toBe(1);
  });
});
