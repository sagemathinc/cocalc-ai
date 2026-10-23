import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { AgentStore } from "./store";
import { cleanupAgentMessagingHistory } from "./maintenance";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("Agent Network retention", () => {
  const db = new AgentStore();
  const tables = [
    "agent_rpc_admission_state",
    "agent_rpc_report_executions",
    "agent_network_mutations",
    "agent_network_activity",
    "agent_network_proposals",
    "agent_network_broadcasts",
    "agent_external_inbox",
    "agent_external_inbox_attachments",
  ];
  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
    await db.query(`CREATE TABLE IF NOT EXISTS agent_identity_runs(
      agent_id uuid,run_id uuid,ended_at timestamptz,expires_at timestamptz)`);
    await db.query(`CREATE TABLE IF NOT EXISTS agent_external_installations(
      installation_id uuid PRIMARY KEY,state text,created_at timestamptz,expires_at timestamptz)`);
    await db.query(
      `CREATE TABLE IF NOT EXISTS accounts(account_id uuid PRIMARY KEY,home_bay_id text)`,
    );
    await db.query(
      `CREATE TABLE IF NOT EXISTS api_keys(account_id uuid,key_id text)`,
    );
    await db.query(`CREATE TABLE IF NOT EXISTS agent_cocalc_connector_turns(
      turn_id uuid PRIMARY KEY,account_id uuid,key_id text,secret_ciphertext text,
      ended_at timestamptz,expires_at timestamptz)`);
  });
  beforeEach(async () => {
    for (const table of tables) await db.query(`DELETE FROM ${table}`);
  });

  test("removes expired bounded coordination state", async () => {
    const account = randomUUID();
    await db.query(
      `INSERT INTO agent_network_mutations
       (account_id,request_id,binding_hash,agent_network_id,created_at)
       VALUES($1,$2,'hash',$3,now()-interval '31 days')`,
      [account, randomUUID(), randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_network_proposals
       (proposal_id,account_id,source,title,delivery_mode,members,state,binding_hash,expires_at)
       VALUES($1,$2,$3,'Expired network','queued',$4,'expired','hash',now()-interval '31 days')`,
      [
        randomUUID(),
        account,
        { project_id: randomUUID(), agent_id: randomUUID() },
        [],
      ],
    );
    await db.query(
      `INSERT INTO agent_rpc_report_executions
       (attempt_id,report_id,account_id,project_id,host_id,path,thread_id,expires_at)
       VALUES($1,$2,$3,$4,$5,'a.chat','t',now()-interval '1 minute'),
             ($6,$2,$3,$4,$5,'a.chat','t',now()+interval '1 day')`,
      [
        randomUUID(),
        randomUUID(),
        account,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    // Attachments: one expired, one whose message is gone, one kept.
    const kept = randomUUID();
    await db.query(
      `INSERT INTO agent_external_inbox
       (message_id,attempt_id,account_id,installation_id,agent_network_id,
        network_generation,source,body,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'hi',now()+interval '1 day')`,
      [
        kept,
        randomUUID(),
        account,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify({ project_id: randomUUID(), agent_id: randomUUID() }),
      ],
    );
    for (const [message_id, expires] of [
      [kept, "now()-interval '1 minute'"],
      [randomUUID(), "now()+interval '1 day'"],
      [kept, "now()+interval '1 day'"],
    ])
      await db.query(
        `INSERT INTO agent_external_inbox_attachments
         (message_id,idx,account_id,installation_id,name,size,sha256,data,expires_at)
         VALUES($1,(SELECT count(*) FROM agent_external_inbox_attachments WHERE message_id=$1),
                $2,$3,'a.txt',1,$4,'\\x61'::bytea,${expires})`,
        [message_id, account, randomUUID(), "a".repeat(64)],
      );
    const result = await cleanupAgentMessagingHistory();
    expect(result.external_inbox_attachments).toBe(2);
    expect(
      (
        await db.query(
          "SELECT message_id FROM agent_external_inbox_attachments",
        )
      ).rows,
    ).toEqual([{ message_id: kept }]);
    expect(result.report_executions).toBe(1);
    expect(result.network_mutations).toBe(1);
    expect(result.network_proposals).toBe(1);
  });
});
