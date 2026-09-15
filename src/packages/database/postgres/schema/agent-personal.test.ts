/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  agentSchemaBackend,
  createAgentSchemaFixture,
} from "./agent-schema-fixture";
import type { AgentSchemaFixture } from "./agent-schema-fixture";
import { SCHEMA } from "@cocalc/util/db-schema";
import { syncSchema, schemaNeedsSync } from "./sync";

let db: AgentSchemaFixture;
jest.mock("@cocalc/database/pool", () => ({
  ...jest.requireActual("@cocalc/database/pool"),
  getClient: () => ({
    connect: async () => {},
    end: async () => {},
    query: (...args) => db.query(...args),
  }),
}));

const tables = [
  "agent_personal_requests",
  "agent_personal_grants",
  "agent_personal_names",
  "agent_personal_controls",
];
const schema = Object.fromEntries(tables.map((name) => [name, SCHEMA[name]]));
const indexes = [
  "agent_personal_current_endpoint",
  "agent_personal_grant_source",
  "agent_personal_approval_direction",
  "agent_personal_grant_group",
  "agent_personal_pending",
];

async function objects() {
  return (
    await db.query(
      "SELECT oid::text,relname FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname",
      [[...tables, ...indexes]],
    )
  ).rows;
}
async function snapshot() {
  const result: Record<string, unknown[]> = {};
  for (const table of tables)
    result[table] = (
      await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)
    ).rows;
  return result;
}
async function seed() {
  const account = randomUUID(),
    other = randomUUID(),
    project = randomUUID(),
    agent = randomUUID(),
    targetProject = randomUUID(),
    targetAgent = randomUUID();
  const approval = randomUUID(),
    group = randomUUID(),
    request = randomUUID(),
    alias = randomUUID();
  await db.query("INSERT INTO agent_personal_controls(account_id) VALUES($1)", [
    account,
  ]);
  await db.query(
    "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'reviewer',$2,$3,$4)",
    [
      account,
      project,
      agent,
      {
        path: "/home/user/review.chat",
        thread_id: "thread",
        description: "snapshot",
      },
    ],
  );
  await db.query(
    `INSERT INTO agent_personal_grants(link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}','review',NULL)`,
    [
      randomUUID(),
      account,
      project,
      agent,
      targetProject,
      targetAgent,
      group,
      approval,
    ],
  );
  await db.query(
    `INSERT INTO agent_personal_requests(request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'pending',now()+interval '15 minutes')`,
    [
      request,
      account,
      project,
      agent,
      randomUUID(),
      {
        target: { project_id: targetProject, agent_id: targetAgent },
        reason: "review",
        ttl_seconds: null,
        both_directions: true,
        allow_guidance: false,
      },
    ],
  );
  await db.query(
    `INSERT INTO agent_personal_requests(request_id,canonical_request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at)
    SELECT $1,request_id,account_id,source_project_id,source_agent_id,run_id,request,'pending',expires_at FROM agent_personal_requests WHERE request_id=$2`,
    [alias, request],
  );
  return {
    account,
    other,
    project,
    agent,
    targetProject,
    targetAgent,
    approval,
    group,
    request,
    alias,
  };
}

describe("personal agent account-home declarative schema", () => {
  let oldDatabase: string | undefined;
  beforeEach(async () => {
    oldDatabase = process.env.COCALC_DB;
    process.env.COCALC_DB = agentSchemaBackend();
    db = await createAgentSchemaFixture();
  });
  afterEach(async () => {
    await db.end();
    if (oldDatabase == null) delete process.env.COCALC_DB;
    else process.env.COCALC_DB = oldDatabase;
  });

  test("durable private tables need no local accounts/projects/identities", async () => {
    for (const table of tables) {
      expect(SCHEMA[table].user_query).toBeUndefined();
      expect(SCHEMA[table].project_query).toBeUndefined();
      expect(SCHEMA[table].virtual).toBeUndefined();
      expect(SCHEMA[table].external).toBeUndefined();
      expect(SCHEMA[table].durability).not.toBe("ephemeral");
      for (const constraint of SCHEMA[table].pg_constraints ?? [])
        if (constraint.type === "foreign-key")
          expect(constraint.references.table).toBe("agent_personal_requests");
    }
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    await seed();
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(
      (
        await db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('accounts','projects','agent_identities')",
        )
      ).rows,
    ).toEqual([]);
  });

  test("repeated startup sync preserves rows, nullable expiry, IDs, and indexes", async () => {
    await syncSchema(schema);
    await seed();
    const before = await snapshot(),
      ids = await objects();
    await syncSchema(schema);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await objects()).toEqual(ids);
    expect(
      (await db.query("SELECT paused,generation FROM agent_personal_controls"))
        .rows,
    ).toEqual([{ paused: false, generation: 0 }]);
    expect(
      (
        await db.query(
          "SELECT expires_at,paused,generation,allow_guidance,last_attempt_at,last_accepted_at FROM agent_personal_grants",
        )
      ).rows,
    ).toEqual([
      {
        expires_at: null,
        paused: false,
        generation: 0,
        allow_guidance: false,
        last_attempt_at: null,
        last_accepted_at: null,
      },
    ]);
    const columns = (
      await db.query(
        "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name=ANY($1::text[]) AND column_name IN ('expires_at','created_at','request','metadata')",
        [tables],
      )
    ).rows;
    expect(columns).toContainEqual({
      table_name: "agent_personal_grants",
      column_name: "expires_at",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });
    expect(columns).toContainEqual({
      table_name: "agent_personal_requests",
      column_name: "expires_at",
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    expect(columns).toContainEqual({
      table_name: "agent_personal_requests",
      column_name: "request",
      data_type: "jsonb",
      is_nullable: "NO",
    });
  });

  test("enforces account/name and current endpoint uniqueness while retaining tombstones", async () => {
    await syncSchema(schema);
    const ids = await seed();
    const insert = (
      account: string,
      name: string,
      agent: string,
      retired: boolean,
    ) =>
      db.query(
        "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata,retired_at) VALUES($1,$2,$3,$4,'{}',CASE WHEN $5 THEN now() END)",
        [account, name, ids.project, agent, retired],
      );
    await expect(
      insert(ids.account, "another", ids.agent, false),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_personal_current_endpoint",
    });
    await insert(ids.account, "retired", ids.agent, true);
    await expect(
      insert(ids.account, "retired", randomUUID(), false),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_personal_names_pkey",
    });
    await insert(ids.other, "reviewer", ids.agent, false);
    await expect(
      db.query("UPDATE agent_personal_names SET metadata=NULL"),
    ).rejects.toMatchObject({ code: "23502" });
  });

  test("direction uniqueness and local canonical request FK survive synchronization", async () => {
    await syncSchema(schema);
    const ids = await seed();
    await expect(
      db.query(
        `INSERT INTO agent_personal_grants(link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason)
      SELECT $1,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason FROM agent_personal_grants`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_personal_approval_direction",
    });
    await db.query(
      `INSERT INTO agent_personal_grants(link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason,expires_at)
      SELECT $1,account_id,target_project_id,target_agent_id,source_project_id,source_agent_id,direction_group_id,approval_request_id,approval,reason,now()+interval '1 hour' FROM agent_personal_grants`,
      [randomUUID()],
    );
    expect(
      (await db.query("SELECT * FROM agent_personal_grants")).rows,
    ).toHaveLength(2);
    await expect(
      db.query(
        "UPDATE agent_personal_requests SET canonical_request_id=$1 WHERE request_id=$2",
        [randomUUID(), ids.alias],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.query("DELETE FROM agent_personal_requests WHERE request_id=$1", [
        ids.request,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
  });

  test("repairs declared index/default/nullability drift without replacing data", async () => {
    await syncSchema(schema);
    await seed();
    const before = await snapshot();
    await db.query("DROP INDEX agent_personal_current_endpoint");
    await db.query(
      "CREATE UNIQUE INDEX agent_personal_current_endpoint ON agent_personal_names(account_id,agent_id)",
    );
    await db.query(
      "ALTER TABLE agent_personal_controls ALTER COLUMN paused DROP DEFAULT",
    );
    await db.query(
      "ALTER TABLE agent_personal_requests ALTER COLUMN generation DROP NOT NULL",
    );
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT indexdef FROM pg_indexes WHERE indexname='agent_personal_current_endpoint'",
        )
      ).rows[0].indexdef,
    ).toContain("WHERE (retired_at IS NULL)");
  });

  test("alias migration is additive and leaves existing personal request state unchanged", async () => {
    const { canonical_request_id: _canonical, ...fields } =
      SCHEMA.agent_personal_requests.fields;
    await syncSchema({
      ...schema,
      agent_personal_requests: {
        ...SCHEMA.agent_personal_requests,
        fields,
        pg_constraints: [],
      },
    });
    const request_id = randomUUID();
    await db.query(
      "INSERT INTO agent_personal_requests(request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at) VALUES($1,$2,$3,$4,$5,'{}','denied',now())",
      [request_id, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
    const before = (await db.query("SELECT * FROM agent_personal_requests"))
      .rows[0];
    await syncSchema(schema);
    expect(
      (await db.query("SELECT * FROM agent_personal_requests")).rows,
    ).toEqual([{ ...before, canonical_request_id: null }]);
    expect(await schemaNeedsSync(schema)).toBe(false);
  });

  test("new personal tables do not reinterpret shared grants or pending/uncertain legacy delivery", async () => {
    // Frozen legacy fixtures intentionally outside the personal schema.
    await db.query(
      "CREATE TABLE agent_rpc_links(link_id uuid PRIMARY KEY, approved_by uuid NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz)",
    );
    await db.query(
      "CREATE TABLE agent_message_inbox(message_id uuid PRIMARY KEY, state text NOT NULL, body text NOT NULL)",
    );
    await db.query(
      "INSERT INTO agent_rpc_links VALUES($1,$2,now()+interval '1 hour',NULL)",
      [randomUUID(), randomUUID()],
    );
    await db.query(
      "INSERT INTO agent_message_inbox VALUES($1,'pending','old pending'),($2,'unconfirmed','old uncertain')",
      [randomUUID(), randomUUID()],
    );
    const legacy = async () => ({
      grants: (await db.query("SELECT * FROM agent_rpc_links")).rows,
      inbox: (
        await db.query("SELECT * FROM agent_message_inbox ORDER BY state")
      ).rows,
    });
    const before = await legacy();
    await syncSchema(schema);
    await syncSchema(schema);
    expect(await legacy()).toEqual(before);
    for (const table of tables)
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  });
});
