/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  agentSchemaBackend,
  createAgentSchemaFixture,
} from "./agent-schema-fixture";
import type { AgentSchemaFixture } from "./agent-schema-fixture";
import { SCHEMA } from "@cocalc/util/db-schema";
import { schemaNeedsSync, syncSchema } from "./sync";

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
  "agent_external_installations",
  "agent_external_identities",
  "agent_external_inbox",
];
const schema = Object.fromEntries(tables.map((name) => [name, SCHEMA[name]]));
async function snapshot() {
  return {
    identities: (
      await db.query(
        "SELECT * FROM agent_external_identities ORDER BY agent_id",
      )
    ).rows,
    installations: (
      await db.query(
        "SELECT * FROM agent_external_installations ORDER BY installation_id",
      )
    ).rows,
  };
}

describe("external agent schema persistence", () => {
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

  async function seed() {
    const agent = randomUUID(),
      account = randomUUID();
    await db.query(
      "INSERT INTO agent_external_identities(agent_id,account_id,label,disabled_at) VALUES($1,$2,'QA identity',now())",
      [agent, account],
    );
    for (const state of ["active", "revoked"]) {
      await db.query(
        `INSERT INTO agent_external_installations
        (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,agent_network_id,expires_at)
        VALUES($1,$2,$3,'QA installation','fixture-only-hash',$4,3,$5,$6,now()-interval '1 hour')`,
        [
          randomUUID(),
          account,
          agent,
          state,
          { ttl_seconds: 3600, label: "QA installation" },
          randomUUID(),
        ],
      );
    }
  }

  test("fresh and repeated sync preserve expiry, network binding and object identity", async () => {
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    await seed();
    const before = await snapshot();
    const objects = async () =>
      (
        await db.query(`SELECT oid::text,relname FROM pg_class
      WHERE relname IN ('agent_external_installations','agent_external_identities','agent_external_installation_account') ORDER BY relname`)
      ).rows;
    const ids = await objects();
    await syncSchema(schema);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await objects()).toEqual(ids);
    expect(before.installations).toHaveLength(2);
    expect(before.installations[0].agent_network_id).toBeTruthy();
  });

  test("repairs index and default drift without rewriting existing installations", async () => {
    await syncSchema(schema);
    await seed();
    const before = await snapshot();
    await db.query("DROP INDEX agent_external_installation_account");
    await db.query(
      "ALTER TABLE agent_external_installations ALTER COLUMN created_at DROP DEFAULT",
    );
    expect(await schemaNeedsSync(schema)).toBe(true);
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});
