/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Races that need real concurrent transactions, on a throwaway PostgreSQL
// (skipped without server binaries). Every computers and agent-network
// transaction takes the account-rehome fence first, so the test forces an
// exact order: hold that lock, start A and wait until it is blocked, start B,
// release. Postgres grants the lock in queue order.

import { randomUUID } from "node:crypto";
import {
  postgresBinDir,
  startRealPostgres,
  waitForLockWaiters,
  type RealPostgres,
} from "@cocalc/server/test/real-postgres";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: async (name: string, value: string) =>
    `test-enc:${name}:${Buffer.from(value).toString("base64")}`,
  decryptSecretStorageValue: async (name: string, value: string) => ({
    value: Buffer.from(
      value.slice(`test-enc:${name}:`.length),
      "base64",
    ).toString(),
    needsMigration: false,
  }),
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));

jest.setTimeout(60_000);

const describeReal = postgresBinDir() != null ? describe : describe.skip;

const tables = [
  "accounts",
  "projects",
  "public_project_paths",
  "agent_personal_controls",
  "agent_personal_names",
  "agent_networks",
  "agent_network_members",
  "agent_network_mutations",
  "agent_network_activity",
  "agent_network_proposals",
  "agent_network_broadcasts",
  "agent_external_identities",
  "agent_external_installations",
  "agent_external_inbox",
  "account_computers",
  "account_computer_requests",
  "account_computer_operations",
  "account_computer_jobs",
  "account_computer_ticket_log",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
];

describeReal("computers: races on real PostgreSQL", () => {
  let pg: RealPostgres;
  let pool: any;
  let store: any;
  const account = randomUUID();
  const project = randomUUID();
  const source = { project_id: project, agent_id: randomUUID() };
  const peer = { project_id: project, agent_id: randomUUID() };
  const newcomer = { project_id: project, agent_id: randomUUID() };

  beforeAll(async () => {
    pg = startRealPostgres();
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
    pool = (await import("@cocalc/database/pool")).default();
    const { AgentStore } = await import("@cocalc/server/agents/store");
    const { PersonalAgentStore } =
      await import("@cocalc/server/agents/personal-store");
    store = new PersonalAgentStore(
      new AgentStore(),
      async (_account: string, endpoint: any) =>
        ({
          ...endpoint,
          path: "/home/user/test.chat",
          thread_id: endpoint.agent_id,
          created_by: account,
        }) as any,
      async () => account,
      // The real account-rehome fence and home-bay check (the default).
      undefined,
      async () => false,
    );
  });

  afterAll(async () => {
    await pool?.end?.().catch(() => {});
    pg?.stop();
  });

  let network: string;

  beforeEach(async () => {
    for (const t of tables.slice().reverse())
      await pool.query(`DELETE FROM ${t}`);
    (await import("./signing-keys")).resetSigningKeyCacheForTesting();
    await pool.query(
      "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'a@example.org',now())",
      [account],
    );
    await pool.query(
      "INSERT INTO projects (project_id, users, runtime_authority_revision) VALUES ($1,$2,1)",
      [project, JSON.stringify({ [account]: { group: "owner" } })],
    );
    for (const [endpoint, name] of [
      [source, "builder"],
      [peer, "reviewer"],
      [newcomer, "newcomer"],
    ] as const) {
      await store.name(account, { endpoint, name });
    }
    const created = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Lab",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    network = created.agent_network_id;
  });

  let pendingRelease: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await pendingRelease?.();
  });

  /** Hold the account-rehome fence until release() is called. */
  async function block() {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["account-rehome", account],
    );
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      pendingRelease = undefined;
      await client.query("COMMIT");
      client.release();
    };
    pendingRelease = release;
    return release;
  }

  /**
   * Hold the network row until release(). add-member then waits on it while
   * holding the rehome fence, so anything after it queues behind it.
   */
  async function blockNetwork() {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT 1 FROM agent_networks WHERE agent_network_id=$1 FOR UPDATE",
      [network],
    );
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      pendingRelease = undefined;
      await client.query("COMMIT");
      client.release();
    };
    pendingRelease = release;
    return release;
  }

  const waiters = (n: number) =>
    waitForLockWaiters((sql) => pool.query(sql), n);

  async function generation(): Promise<string> {
    const { rows } = await pool.query(
      "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
      [network],
    );
    return rows[0].generation;
  }

  const policy = () => ({
    version: 1,
    mode: "direct",
    duration: null,
    agent_network_id: network,
    network: "on",
    gpu: true,
    mounts: [],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  });

  /** A request the machine has paired; the owner hasn't approved yet. */
  async function pairedRequest() {
    const { createComputerRequest, getPairingView, submitPairing } =
      await import("./requests");
    const { parseComputerPolicy } =
      await import("@cocalc/util/computers/policy");
    const { SIGNED_KINDS } = await import("@cocalc/util/computers/protocol");
    const crypto = await import("@cocalc/backend/computers/crypto");
    const { request_id } = await createComputerRequest({
      account_id: account,
      name: "bench",
      requested_policy: policy(),
    });
    const view = await getPairingView(request_id);
    const signing = crypto.generateSigningKey();
    const resolved = parseComputerPolicy(policy());
    const { transcript_hash } = await submitPairing({
      request_id,
      transcript: crypto.signEnvelope(
        SIGNED_KINDS.transcript,
        {
          type: "cocalc-computer-pairing",
          version: 1,
          site: view.site,
          cluster_id: view.cluster_id,
          request_id,
          account_id: account,
          policy_hash: crypto.policyHash(resolved),
          signing_key: signing.fingerprint,
          agreement_key: crypto.generateAgreementKey().fingerprint,
          client_nonce: crypto.randomNonce(),
          server_nonce: view.server_nonce,
          machine: { hostname: "bench", os: "linux", arch: "x64", user: "w" },
        },
        signing,
      ),
      signing_public_key: signing.publicDer,
      resolved_policy: resolved,
    });
    return { request_id, transcript_hash };
  }

  const addNewcomer = (fresh: boolean) =>
    store.updateNetwork(
      account,
      {
        request_id: randomUUID(),
        agent_network_id: network,
        action: "add-member",
        member: { kind: "registered", endpoint: newcomer },
      },
      8,
      fresh,
    );

  describe("adding a member and approving a computer", () => {
    it("needs fresh auth to add a member while a request is open", async () => {
      await pairedRequest();
      await expect(addNewcomer(false)).rejects.toThrow("fresh_auth_required");
    });

    it("approval first: it serves the members the owner saw; the add then needs fresh auth", async () => {
      const { approveComputerRequest } = await import("./requests");
      const { request_id, transcript_hash } = await pairedRequest();
      const seen = await generation();
      const release = await block();
      const approve = approveComputerRequest({
        account_id: account,
        request_id,
        transcript_hash,
        agent_network_generation: seen,
      });
      await waiters(1);
      const add = addNewcomer(false);
      await waiters(2);
      await release();
      await expect(approve).resolves.toHaveProperty("computer_id");
      await expect(add).rejects.toThrow("fresh_auth_required");
    });

    it("add first: approval of the membership the owner saw is refused", async () => {
      const { approveComputerRequest } = await import("./requests");
      const { request_id, transcript_hash } = await pairedRequest();
      const seen = await generation();
      const release = await blockNetwork();
      const add = addNewcomer(true);
      await waiters(1);
      const approve = approveComputerRequest({
        account_id: account,
        request_id,
        transcript_hash,
        agent_network_generation: seen,
      });
      await waiters(2);
      await release();
      await expect(add).resolves.toBeDefined();
      await expect(approve).rejects.toThrow(/agent network changed/);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM account_computers",
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe("the first-ever pause and a ticket", () => {
    async function approved() {
      const { approveComputerRequest } = await import("./requests");
      const { request_id, transcript_hash } = await pairedRequest();
      return await approveComputerRequest({
        account_id: account,
        request_id,
        transcript_hash,
        agent_network_generation: await generation(),
      });
    }

    async function ticket() {
      const { issueComputerTicket } = await import("./tickets");
      const { attestProjectLocal } = await import("./attestation");
      const { generateSigningKey } =
        await import("@cocalc/backend/computers/crypto");
      return await issueComputerTicket({
        account_id: account,
        agent_id: source.agent_id,
        run_id: randomUUID(),
        source_project_id: project,
        run_expires_at: Date.now() + 3_600_000,
        computer: "bench",
        operation: "exec",
        request: { command: "true" },
        operation_id: randomUUID(),
        pop_key: generateSigningKey().publicDer,
        attestation: await attestProjectLocal({
          project_id: project,
          account_id: account,
          home_bay_id: "bay-0",
        }),
      });
    }

    const pause = () => store.setControls(account, { action: "pause" });

    async function epoch(computer_id: string) {
      const { rows } = await pool.query(
        "SELECT epoch FROM account_computers WHERE computer_id=$1",
        [computer_id],
      );
      return Number(rows[0].epoch);
    }

    it("ticket first: it is issued, and the pause then bumps the epoch past it", async () => {
      const { computer_id } = await approved();
      await pool.query("DELETE FROM agent_personal_controls");
      const before = await epoch(computer_id);
      const release = await block();
      const t = ticket();
      await waiters(1);
      const p = pause();
      await waiters(2);
      await release();
      const issued: any = await t;
      await p;
      expect(issued.ticket.payload.computer_epoch).toBe(before);
      expect(await epoch(computer_id)).toBe(before + 1);
    });

    it("pause first: the ticket is refused", async () => {
      await approved();
      await pool.query("DELETE FROM agent_personal_controls");
      const release = await block();
      const p = pause();
      await waiters(1);
      const t = ticket();
      await waiters(2);
      await release();
      await p;
      await expect(t).rejects.toThrow(/agent messaging is paused/);
    });
  });

  describe("a computer request and an account rehome", () => {
    async function startRehome() {
      const { lockAccountRehomeFence } =
        await import("@cocalc/server/accounts/rehome-fence");
      const { assertNoPersonalStateForRehome } =
        await import("@cocalc/server/agents/personal-rehome");
      await pool.query(
        `CREATE TABLE IF NOT EXISTS account_rehome_operations
           (op_id TEXT, account_id UUID, source_bay_id TEXT, dest_bay_id TEXT,
            stage TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockAccountRehomeFence({ db: client, account_id: account });
        // The computers part of the inventory, isolated from the network
        // (which blocks rehome on its own).
        await assertNoPersonalStateForRehome(
          {
            query: (sql: string, values?: unknown[]) =>
              /agent_|personal_|people_/.test(sql) &&
              !/account_computer/.test(sql)
                ? Promise.resolve({ rows: [] })
                : client.query(sql, values),
          },
          account,
        );
        await client.query(
          `INSERT INTO account_rehome_operations VALUES ('op1',$1,'bay-0','bay-1','copy','running',now())`,
          [account],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    afterEach(async () => {
      await pool.query("DROP TABLE IF EXISTS account_rehome_operations");
    });

    it("rehome first: the request is refused", async () => {
      const { createComputerRequest } = await import("./requests");
      const release = await block();
      const rehome = startRehome();
      await waiters(1);
      const create = createComputerRequest({
        account_id: account,
        name: "late",
        requested_policy: policy(),
      });
      await waiters(2);
      await release();
      await rehome;
      await expect(create).rejects.toThrow(/account rehome op1 is running/);
    });

    it("request first: the rehome is refused", async () => {
      const { createComputerRequest } = await import("./requests");
      const release = await block();
      const create = createComputerRequest({
        account_id: account,
        name: "early",
        requested_policy: policy(),
      });
      await waiters(1);
      const rehome = startRehome();
      await waiters(2);
      await release();
      await create;
      await expect(rehome).rejects.toThrow(/Account rehome is unavailable/);
    });
  });

  describe("the owning bay's attestation, public shares and project rehome", () => {
    const attest = async () =>
      (
        await (
          await import("./attestation")
        ).attestProjectLocal({
          project_id: project,
          account_id: account,
          home_bay_id: "bay-0",
        })
      ).payload;

    /** Hold a lock (given by sql) in an open transaction until released. */
    async function hold(sql: string, values: unknown[]) {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(sql, values);
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        pendingRelease = undefined;
        await client.query("COMMIT");
        client.release();
      };
      pendingRelease = release;
      return { client, release };
    }

    it("share first: the attestation waits for it and sees it", async () => {
      const before = await attest();
      const share = await hold(
        "INSERT INTO public_project_paths (id, project_id, path, visibility, disabled) VALUES ($1,$2,'pub','listed',false)",
        [randomUUID(), project],
      );
      const after = attest();
      await waiters(1);
      await share.release();
      const a = await after;
      expect(a.eligible).toBe(false);
      expect(a.privacy_epoch).toBeGreaterThan(before.privacy_epoch);
    });

    it("attestation first: the share waits for its read, then advances the epoch", async () => {
      const before = await attest();
      // What the attestation holds while it reads: the project row FOR SHARE.
      const read = await hold(
        "SELECT 1 FROM projects WHERE project_id=$1 FOR SHARE",
        [project],
      );
      const share = pool.query(
        "INSERT INTO public_project_paths (id, project_id, path, visibility, disabled) VALUES ($1,$2,'pub','listed',false)",
        [randomUUID(), project],
      );
      await waiters(1);
      await read.release();
      await share;
      const a = await attest();
      expect(a.eligible).toBe(false);
      expect(a.privacy_epoch).toBeGreaterThan(before.privacy_epoch);
    });

    async function rehomeTable() {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS project_rehome_operations
           (op_id TEXT, project_id UUID, source_bay_id TEXT, dest_bay_id TEXT,
            stage TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
      );
    }
    afterEach(async () => {
      await pool.query("DROP TABLE IF EXISTS project_rehome_operations");
    });

    it("rehome first: the old owner refuses to attest", async () => {
      await rehomeTable();
      // As createProjectRehomeOperation does: the fence, then the running row.
      const rehome = await hold(
        "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
        ["project-rehome", project],
      );
      await rehome.client.query(
        "INSERT INTO project_rehome_operations VALUES ('p1',$1,'bay-0','bay-1','requested','running',now())",
        [project],
      );
      const a = attest();
      await waiters(1);
      await rehome.release();
      await expect(a).rejects.toThrow(/project rehome p1 is running/);
    });

    it("attestation first: the rehome waits until the attestation is done", async () => {
      await rehomeTable();
      // Hold the attestation inside its fence (blocked on the project row).
      const row = await hold(
        "SELECT 1 FROM projects WHERE project_id=$1 FOR UPDATE",
        [project],
      );
      const a = attest();
      await waiters(1);
      let rehomeStarted = false;
      const rehome = (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
            ["project-rehome", project],
          );
          rehomeStarted = true;
          await client.query(
            "INSERT INTO project_rehome_operations VALUES ('p2',$1,'bay-0','bay-1','requested','running',now())",
            [project],
          );
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      })();
      await waiters(2);
      expect(rehomeStarted).toBe(false);
      await row.release();
      expect((await a).eligible).toBe(true);
      await rehome;
      await expect(attest()).rejects.toThrow(/project rehome p2 is running/);
    });
  });
});
