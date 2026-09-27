/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Opt-in real PostgreSQL test: authority/transport checks are doubles, but all
// issuance SQL, advisory locks, account counters, and transactions are real.
const database = process.env.COCALC_TEST_MANAGED_POSTGRES_DB;
const describePostgres = database ? describe : describe.skip;
const schema = `connector_test_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
const publish = jest.fn(async () => undefined);
const owner = randomUUID();
const agent = randomUUID();
const project = randomUUID();
const host = randomUUID();
const scope = { version: 1, account: ["project:list"], projects: [] };

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => pool,
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  assertAccountNotRehoming: async () => undefined,
  assertAccountWriteOnHomeBay: async () => undefined,
}));
jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: (secret: string) => `test-hash:${secret}`,
  verifyPassword: (secret: string, hash: string) =>
    hash === `test-hash:${secret}`,
}));
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (_name: string, secret: string) => secret,
  decryptSecretStorageValue: async (_name: string, value: string) => ({
    value,
  }),
}));
jest.mock("@cocalc/server/api/manage", () => ({
  createApiKeySecret: ({ key_id }) => `synthetic.${key_id}`,
  ensureApiKeysV2Schema: async () => undefined,
  syncAccountApiKeyDirectory: (...args) => publish(...args),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertAccountProjectHostTokenProjectAccess: async () => undefined,
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: async () => undefined,
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  deleteClusterAccountApiKeyDirectoryEntry: async () => undefined,
  getClusterAccountById: async () => ({ home_bay_id: "test" }),
}));
jest.mock("@cocalc/server/api/scope-project-access", () => ({
  assertProjectFullCollaborator: async () => undefined,
  assertScopeProjectsCollaborator: async () => undefined,
}));
jest.mock("@cocalc/server/api/project-membership-revocation", () => ({
  assertApiKeyProjectMembership: async () => undefined,
}));
jest.mock("@cocalc/server/api/api-key-audit", () => ({
  recordApiKeyAuditEvent: async () => undefined,
}));
jest.mock("./identity-routing", () => ({
  verifyActiveAgentRun: async () => undefined,
}));
jest.mock("./api", () => ({
  getIdentity: async () => ({ path: "test.chat", thread_id: "thread" }),
}));
jest.mock("./cocalc-connector-config", () => ({
  assertAccountHome: async () => undefined,
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: () => ({
    verifyActiveAcpConnectorTurn: async () => undefined,
  }),
}));

describePostgres("managed issuance across PostgreSQL connections", () => {
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
      CREATE TABLE accounts(account_id uuid PRIMARY KEY, deleted boolean, api_key_issuance_sequence bigint);
      CREATE TABLE api_keys(id bigserial PRIMARY KEY, account_id uuid, created timestamptz,
        expire timestamptz, name text, key_id text UNIQUE, hash text, trunc text,
        capabilities text[], allowed_project_ids uuid[], scope jsonb,
        issuance_sequence bigint, scope_revision integer DEFAULT 1);
      CREATE TABLE agent_cocalc_connector_configs(config_id uuid, account_id uuid,
        agent_id uuid, source_project_id uuid, scope jsonb, revision integer, enabled boolean);
      CREATE TABLE agent_cocalc_connector_turns(turn_id uuid PRIMARY KEY, account_id uuid,
        agent_id uuid, source_project_id uuid, source_host_id uuid, run_id uuid,
        idempotency_key uuid, chat_path text, message_date text, message_id text,
        thread_id text, config_id uuid, config_revision integer, key_id text,
        secret_ciphertext text, expires_at timestamptz, ended_at timestamptz,
        renewed_at timestamptz, created_at timestamptz DEFAULT now(),
        UNIQUE(account_id,agent_id,source_project_id,run_id,idempotency_key));
    `);
  });
  beforeEach(async () => {
    publish.mockClear();
    await pool.query(
      "TRUNCATE accounts,api_keys,agent_cocalc_connector_configs,agent_cocalc_connector_turns",
    );
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [owner]);
    await pool.query(
      "INSERT INTO agent_cocalc_connector_configs VALUES($1,$2,$3,$4,$5,1,true)",
      [randomUUID(), owner, agent, project, scope],
    );
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });
  function request() {
    return {
      account_id: owner,
      agent_id: agent,
      source_project_id: project,
      host_id: host,
      run_id: randomUUID(),
      idempotency_key: randomUUID(),
      turn_ref: {
        chat_path: "test.chat",
        thread_id: "thread",
        message_date: new Date().toISOString(),
        message_id: randomUUID(),
      },
    };
  }
  async function counts() {
    return (
      await pool.query(
        `SELECT
      (SELECT count(*)::int FROM api_keys) AS keys,
      (SELECT count(*)::int FROM agent_cocalc_connector_turns) AS turns,
      (SELECT api_key_issuance_sequence::text FROM accounts WHERE account_id=$1) AS sequence`,
        [owner],
      )
    ).rows[0];
  }
  test("concurrent retries commit exactly one key and return identical credentials", async () => {
    const { beginManagedCocalcConnectorTurn } =
      await import("./cocalc-connector-turn");
    const args = request();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => beginManagedCocalcConnectorTurn(args)),
    );
    expect(
      results.every(
        (value) => JSON.stringify(value) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(await counts()).toEqual({ keys: 1, turns: 1, sequence: "1" });
  }, 30000);
  test("concurrent distinct agents cannot overrun the per-account burst budget", async () => {
    const { beginManagedCocalcConnectorTurn } =
      await import("./cocalc-connector-turn");
    const requests = Array.from({ length: 20 }, () => ({
      ...request(),
      agent_id: randomUUID(),
    }));
    for (const args of requests) {
      await pool.query(
        "INSERT INTO agent_cocalc_connector_configs VALUES($1,$2,$3,$4,$5,1,true)",
        [randomUUID(), owner, args.agent_id, project, scope],
      );
    }
    const results = await Promise.allSettled(
      requests.map((args) => beginManagedCocalcConnectorTurn(args)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(10);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(10);
    for (const result of rejected)
      if (result.status === "rejected")
        expect(result.reason.message).toContain("key limit reached");
    expect(await counts()).toEqual({ keys: 10, turns: 10, sequence: "10" });
    expect(publish).toHaveBeenCalledTimes(10);
  }, 30000);

  test.each(["renew-first", "end-first"])(
    "%s lock contention cannot revive a finalized turn",
    async (order) => {
      const {
        beginManagedCocalcConnectorTurn,
        renewManagedCocalcConnectorTurn,
        endManagedCocalcConnectorTurn,
      } = await import("./cocalc-connector-turn");
      const original = request();
      const issued = await beginManagedCocalcConnectorTurn(original);
      const args = { ...original, turn_id: issued!.turn_id };
      const blocker = await pool.connect();
      const pending: Promise<PromiseSettledResult<unknown>>[] = [];
      const observe = (operation: Promise<unknown>) => {
        const result = operation.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ status: "rejected" as const, reason }),
        );
        pending.push(result);
        return result;
      };
      async function waitForLockWaiters(count: number) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const { rows } = await pool.query(
            `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event_type='Lock'`,
            [schema],
          );
          if (rows[0].count >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw Error(`did not observe ${count} PostgreSQL lock waiters`);
      }
      let renewal: Promise<PromiseSettledResult<unknown>>;
      let ending: Promise<PromiseSettledResult<unknown>>;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT turn_id FROM agent_cocalc_connector_turns WHERE turn_id=$1 FOR UPDATE",
          [issued!.turn_id],
        );
        if (order === "renew-first") {
          renewal = observe(renewManagedCocalcConnectorTurn(args));
          await waitForLockWaiters(1);
          ending = observe(endManagedCocalcConnectorTurn(args));
        } else {
          ending = observe(endManagedCocalcConnectorTurn(args));
          await waitForLockWaiters(1);
          renewal = observe(renewManagedCocalcConnectorTurn(args));
        }
        await waitForLockWaiters(2);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.all(pending);
      }
      expect((await ending!).status).toBe("fulfilled");
      expect((await renewal!).status).toBe(
        order === "renew-first" ? "fulfilled" : "rejected",
      );
      const row = (
        await pool.query(
          "SELECT ended_at,secret_ciphertext FROM agent_cocalc_connector_turns WHERE turn_id=$1",
          [issued!.turn_id],
        )
      ).rows[0];
      expect(row.ended_at).toBeInstanceOf(Date);
      expect(row.secret_ciphertext).toBe("");
      expect(await counts()).toEqual({ keys: 0, turns: 1, sequence: "1" });
      await expect(renewManagedCocalcConnectorTurn(args)).rejects.toThrow(
        "no longer valid",
      );
      await expect(beginManagedCocalcConnectorTurn(original)).rejects.toThrow(
        "no longer valid",
      );
      await expect(
        endManagedCocalcConnectorTurn(args),
      ).resolves.toBeUndefined();
      expect(await counts()).toEqual({ keys: 0, turns: 1, sequence: "1" });
    },
    30000,
  );
});
