/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Opt-in real PostgreSQL test: authorization checks are doubles, but the grant
// SQL, advisory lock and transactions run across real connections.
const database = process.env.COCALC_TEST_MANAGED_POSTGRES_DB;
const describePostgres = database ? describe : describe.skip;
const schema = `cli_connector_test_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
const owner = randomUUID();
const project = randomUUID();
const connectionId = randomUUID();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => pool,
}));
jest.mock("@cocalc/server/external-credentials/store", () => ({
  getExternalCredentialById: async () => ({ id: connectionId }),
}));
jest.mock("./cocalc-connector-config", () => ({
  assertAccountHome: async () => undefined,
  authorizeConfigChange: async () => undefined,
}));
jest.mock("./cocalc-connector-turn", () => ({
  assertTrustedSource: async () => undefined,
  assertLiveTurn: async () => undefined,
}));
jest.mock("./identity-routing", () => ({
  verifyActiveAgentRun: async () => undefined,
}));

describePostgres("CLI connector grants across PostgreSQL connections", () => {
  beforeAll(async () => {
    if (!process.env.PGHOST?.startsWith("/"))
      throw Error("test requires a local PostgreSQL socket");
    const admin = new Pool({ database });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
    pool = new Pool({
      database,
      max: 20,
      application_name: schema,
      options: `-c search_path=${schema} -c statement_timeout=15000`,
    });
    await pool.query(`
      CREATE TABLE agent_connector_grants(grant_id uuid PRIMARY KEY,
        account_id uuid, agent_id uuid, source_project_id uuid, connector text,
        connection_id uuid, scope jsonb, revision integer, enabled boolean,
        created_at timestamptz, updated_at timestamptz,
        UNIQUE(account_id,agent_id,source_project_id,connector));
    `);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM agent_connector_grants");
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  const enable = async (agent_id: string, expected_revision?: number) => {
    const { saveCliConnectorGrant } = await import("./cli-connectors");
    return await saveCliConnectorGrant({
      account_id: owner,
      session_hash: "s",
      agent_id,
      source_project_id: project,
      connector: "github",
      connection_id: connectionId,
      enabled: true,
      expected_revision,
    });
  };

  // The losers must fail as conflicts, not for some unrelated reason.
  const expectOnlyConflicts = (results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) {
      if (r.status === "rejected")
        expect(`${r.reason}`).toContain("connector settings changed");
    }
  };

  it("concurrent first grants cannot exceed the per-account bound", async () => {
    await pool.query(
      `INSERT INTO agent_connector_grants
         SELECT gen_random_uuid(),$1,gen_random_uuid(),$2,'github',$3,'{}',1,
                false,now(),now()
           FROM generate_series(1,499)`,
      [owner, project, connectionId],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => enable(randomUUID())),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect(`${r.reason}`).toContain("too many agents");
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM agent_connector_grants WHERE account_id=$1",
      [owner],
    );
    expect(rows[0].n).toBe(500);
  });

  it("concurrent first writes for one agent: one creates, the rest conflict", async () => {
    const agent = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => enable(agent)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expectOnlyConflicts(results);
    const { rows } = await pool.query(
      "SELECT revision FROM agent_connector_grants WHERE agent_id=$1",
      [agent],
    );
    expect(rows).toEqual([{ revision: 1 }]);
  });

  it("concurrent changes at one revision: exactly one wins", async () => {
    const agent = randomUUID();
    await enable(agent);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => enable(agent, 1)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expectOnlyConflicts(results);
    const { rows } = await pool.query(
      "SELECT revision FROM agent_connector_grants WHERE agent_id=$1",
      [agent],
    );
    expect(rows).toEqual([{ revision: 2 }]);
  });
});
