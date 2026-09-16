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

// Reverse dependency order to exercise the normal two-phase schema sync.
const tables = [
  "agent_message_inbox",
  "agent_message_grants",
  "agent_identity_runs",
  "agent_identities",
];
const schema = Object.fromEntries(tables.map((name) => [name, SCHEMA[name]]));

// Frozen fixture from V1's request-time migration. Do not regenerate this from
// the current schema: it verifies adoption of already-deployed databases.
const legacy = `
CREATE TABLE agent_identities (
  agent_id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(project_id),
  path TEXT NOT NULL, thread_id TEXT NOT NULL, name TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), disabled_at TIMESTAMPTZ,
  disabled_by UUID, UNIQUE(project_id, path, thread_id)
);
CREATE TABLE agent_identity_runs (
  agent_id UUID NOT NULL REFERENCES agent_identities(agent_id), run_id UUID NOT NULL,
  account_id UUID NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ, PRIMARY KEY(agent_id, run_id)
);
CREATE TABLE agent_message_grants (
  grant_id UUID PRIMARY KEY,
  source_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
  target_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
  allow_guidance BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID NOT NULL, reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ, revoked_by UUID
);
CREATE TABLE agent_message_inbox (
  message_id UUID PRIMARY KEY, request_id UUID NOT NULL,
  source_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
  source_run_id UUID NOT NULL, target_agent_id UUID NOT NULL REFERENCES agent_identities(agent_id),
  grant_id UUID NOT NULL REFERENCES agent_message_grants(grant_id),
  body TEXT NOT NULL CHECK(octet_length(body) <= 32768), guidance BOOLEAN NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','dispatched','rejected','unconfirmed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_agent_id, request_id)
);
CREATE INDEX agent_message_pending ON agent_message_inbox(created_at) WHERE state='pending';
CREATE INDEX agent_message_grant_targets ON agent_message_grants(source_agent_id,target_agent_id);
`;

async function seed() {
  const project = randomUUID(),
    account = randomUUID();
  const source = randomUUID(),
    target = randomUUID();
  const run = randomUUID(),
    grant = randomUUID(),
    message = randomUUID();
  await db.query("INSERT INTO projects VALUES($1)", [project]);
  await db.query(
    `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
    VALUES($1,$3,'/home/user/a.chat','source','Source',$4),
          ($2,$3,'/home/user/b.chat','target','Target',$4)`,
    [source, target, project, account],
  );
  await db.query(
    `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
    VALUES($1,$2,$3,'hash',now()+interval '10 minutes')`,
    [source, run, account],
  );
  await db.query(
    `INSERT INTO agent_message_grants(grant_id,source_agent_id,target_agent_id,approved_by,reason,expires_at)
    VALUES($1,$2,$3,$4,'Review',now()+interval '1 hour')`,
    [grant, source, target, account],
  );
  await db.query(
    `INSERT INTO agent_message_inbox(message_id,request_id,source_agent_id,source_run_id,target_agent_id,grant_id,body,guidance,state)
    VALUES($1,$1,$2,$3,$4,$5,'Review this',false,'pending')`,
    [message, source, run, target, grant],
  );
  return { source, target, run, grant, message, project, account };
}

async function snapshot() {
  return Promise.all(
    tables.map(async (table) => ({
      table,
      rows: (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
    })),
  );
}

async function objectIds() {
  return (
    await db.query(
      `SELECT oid::text, relname FROM pg_class
    WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...tables, "agent_message_pending", "agent_message_grant_targets"]],
    )
  ).rows;
}

describe("agent messaging declarative schema", () => {
  let oldDatabase: string | undefined;
  beforeEach(async () => {
    oldDatabase = process.env.COCALC_DB;
    process.env.COCALC_DB = agentSchemaBackend();
    db = await createAgentSchemaFixture();
    await db.query("CREATE TABLE projects(project_id UUID PRIMARY KEY)");
  });
  afterEach(async () => {
    await db.end();
    if (oldDatabase == null) delete process.env.COCALC_DB;
    else process.env.COCALC_DB = oldDatabase;
  });

  test("adding RPC tables preserves legacy state and repeated sync preserves links and fences", async () => {
    await syncSchema(schema);
    await seed();
    const before = await snapshot();
    const extended = {
      ...schema,
      agent_rpc_links: SCHEMA.agent_rpc_links,
      agent_message_project_fences: SCHEMA.agent_message_project_fences,
    };
    await syncSchema(extended);
    expect(await snapshot()).toEqual(before);
    await db.query(
      `INSERT INTO agent_rpc_links
      (link_id,source_agent_id,target_agent_id,target_project_id,approved_by,reason,expires_at,revoked_at)
      SELECT $1,agent_id,$2,$3,created_by,'expired QA link',now()-interval '1 hour',now()
      FROM agent_identities ORDER BY agent_id LIMIT 1`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_message_project_fences(project_id,host_id,generation)
      SELECT project_id,$1,$2 FROM projects`,
      [randomUUID(), randomUUID()],
    );
    const records = async () => ({
      links: (await db.query("SELECT * FROM agent_rpc_links")).rows,
      fences: (await db.query("SELECT * FROM agent_message_project_fences"))
        .rows,
      objects: (
        await db.query(`SELECT oid::text,relname FROM pg_class
        WHERE relname IN ('agent_rpc_links','agent_message_project_fences','agent_rpc_link_source')
        ORDER BY relname`)
      ).rows,
    });
    const saved = await records();
    await syncSchema(extended);
    await syncSchema(extended);
    expect(await schemaNeedsSync(extended)).toBe(false);
    expect(await records()).toEqual(saved);
    expect(await snapshot()).toEqual(before);
  });

  test("legacy thread uniqueness converges to recoverable active identity uniqueness", async () => {
    for (const sql of legacy.split(";").filter((s) => s.trim()))
      await db.query(sql);
    const seeded = await seed();
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    await db.query(
      "UPDATE agent_identities SET disabled_at=now() WHERE agent_id=$1",
      [seeded.source],
    );
    await expect(
      db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
         VALUES($1,$2,'/home/user/a.chat','source','Replacement',$3)`,
        [randomUUID(), seeded.project, seeded.account],
      ),
    ).resolves.toBeDefined();
  });

  test("all tables are durable and private, without local account foreign keys", () => {
    for (const table of tables) {
      expect(SCHEMA[table].user_query).toBeUndefined();
      expect(SCHEMA[table].project_query).toBeUndefined();
      expect(SCHEMA[table].virtual).toBeUndefined();
      expect(SCHEMA[table].external).toBeUndefined();
      expect(SCHEMA[table].durability).not.toBe("ephemeral");
      for (const constraint of SCHEMA[table].pg_constraints ?? []) {
        if (constraint.type === "foreign-key") {
          expect(constraint.references.table).not.toBe("accounts");
        }
      }
    }
  });

  test.each(["fresh", "legacy"])(
    "%s tables converge without losing records or replacing tables/indexes",
    async (mode) => {
      if (mode === "legacy") {
        for (const sql of legacy.split(";").filter((s) => s.trim()))
          await db.query(sql);
      } else {
        await syncSchema(schema);
      }
      await seed();
      const before = await snapshot();
      const ids = await objectIds();
      await syncSchema(schema);
      await syncSchema(schema);
      expect(await schemaNeedsSync(schema)).toBe(false);
      const after = await snapshot();
      for (let i = 0; i < before.length; i++) {
        expect(after[i].table).toBe(before[i].table);
        expect(after[i].rows).toHaveLength(before[i].rows.length);
        for (let j = 0; j < before[i].rows.length; j++) {
          expect(after[i].rows[j]).toMatchObject(before[i].rows[j]);
          // Additive compatibility columns must not reinterpret legacy work.
          for (const key of Object.keys(after[i].rows[j])) {
            if (!(key in before[i].rows[j]))
              expect(after[i].rows[j][key]).toBeNull();
          }
        }
      }
      expect(await objectIds()).toEqual(ids);
      const grants = (
        await db.query(
          "SELECT allow_guidance, created_at FROM agent_message_grants",
        )
      ).rows;
      expect(grants[0].allow_guidance).toBe(false);
      expect(grants[0].created_at).toBeInstanceOf(Date);
    },
  );

  test("preserves composite identity/idempotency uniqueness and relational constraints", async () => {
    await syncSchema(schema);
    const ids = await seed();
    await expect(
      db.query(
        `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
      VALUES($1,$2,'/home/user/a.chat','source','Duplicate',$3)`,
        [randomUUID(), ids.project, ids.account],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(
        `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
         VALUES($1,$2,$3,'different-hash',now()+interval '10 minutes')`,
        [ids.source, ids.run, ids.account],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_identity_runs_pkey",
    });
    await expect(
      db.query(
        `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
         VALUES($1,$2,$3,'hash',now()+interval '10 minutes')`,
        [ids.source, randomUUID(), ids.account],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "agent_identity_runs_token_hash_key",
    });
    await db.query(
      `INSERT INTO agent_identity_runs(agent_id,run_id,account_id,token_hash,expires_at)
       VALUES($1,$2,$3,'target-hash',now()+interval '10 minutes')`,
      [ids.target, ids.run, ids.account],
    );
    await expect(
      db.query(`UPDATE agent_message_grants SET target_agent_id=$1`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(db.query(`DELETE FROM projects`)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      db.query(
        `INSERT INTO agent_message_inbox
         (message_id,request_id,source_agent_id,source_run_id,target_agent_id,grant_id,body,guidance,state,created_at,updated_at)
         SELECT $1,request_id,source_agent_id,source_run_id,target_agent_id,grant_id,body,guidance,state,created_at,updated_at FROM agent_message_inbox`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(`UPDATE agent_identity_runs SET token_hash=NULL`),
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      db.query(`UPDATE agent_message_inbox SET body=$1`, ["x".repeat(32769)]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`UPDATE agent_message_inbox SET body=$1`, [
        "\u00e9".repeat(16385),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`UPDATE agent_message_inbox SET state='completed'`),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query(`UPDATE agent_message_inbox SET body=$1`, [
      "x".repeat(32768),
    ]);
  });
});
