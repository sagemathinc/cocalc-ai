/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Ticket issuance against real SQL (in-memory PGlite). Run with
// COCALC_TEST_USE_PGLITE=1 and NODE_OPTIONS=--experimental-vm-modules.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  SIGNED_KINDS,
  ticketRefusals,
  type DaemonState,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "@cocalc/backend/computers/crypto";

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

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "account_computers",
  "account_computer_requests",
  "account_computer_operations",
  "account_computer_jobs",
  "account_computer_ticket_log",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_members",
  "projects",
  "accounts",
];

describeDb("computer tickets", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();

  async function networkGeneration(): Promise<string> {
    const { rows } = await getPool().query(
      "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
      [network],
    );
    return rows[0].generation;
  }
  const agent = randomUUID();
  const project = randomUUID();
  const run = randomUUID();
  let computer_id: string;
  let machineKey: string;
  let ceiling_hash: string;

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    // Members reference networks: delete in reverse order.
    for (const t of tables.slice().reverse())
      await db().query(`DELETE FROM ${t}`);
    (await import("./signing-keys")).resetSigningKeyCacheForTesting();
    await db().query(
      "INSERT INTO accounts (account_id, email_address, created) VALUES ($1,'a@example.org',now())",
      [account],
    );
    await db().query(
      `INSERT INTO agent_networks (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
       VALUES ($1,$2,'lab','active','queued',$3,$2)`,
      [network, account, randomUUID()],
    );
    await db().query(
      `INSERT INTO agent_network_members
         (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
       VALUES ($1,'registered',$2,$2,$3,$4)`,
      [network, agent, project, account],
    );
    await db().query(
      `INSERT INTO projects (project_id, users, runtime_authority_revision) VALUES ($1,$2,5)`,
      [project, JSON.stringify({ [account]: { group: "owner" } })],
    );
    // Pair and approve a computer.
    const {
      createComputerRequest,
      getPairingView,
      submitPairing,
      approveComputerRequest,
    } = await import("./requests");
    const resolved = parseComputerPolicy({
      version: 1,
      mode: "direct",
      duration: { initial_seconds: 3600, max_seconds: 8 * 3600 },
      agent_network_id: network,
      network: "on",
      gpu: true,
      mounts: [],
      images: { kind: "any" },
      scratch_bytes: null,
      limits: { cpu_millis: null, memory_bytes: null, pids: null },
    });
    ceiling_hash = policyHash(resolved);
    const { request_id } = await createComputerRequest({
      account_id: account,
      name: "mac",
      requested_policy: resolved,
    });
    const view = await getPairingView(request_id);
    const signing = generateSigningKey();
    machineKey = signing.fingerprint;
    const transcript = {
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: account,
      policy_hash: ceiling_hash,
      signing_key: signing.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "mac", os: "darwin", arch: "arm64", user: "w" },
    };
    const { transcript_hash } = await submitPairing({
      request_id,
      transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, signing),
      signing_public_key: signing.publicDer,
      resolved_policy: resolved,
    });
    ({ computer_id } = await approveComputerRequest({
      agent_network_generation: await networkGeneration(),
      account_id: account,
      request_id,
      transcript_hash,
    }));
  });

  async function attestation(
    overrides: { project_id?: string; now?: number } = {},
  ) {
    const { attestProjectLocal } = await import("./attestation");
    return await attestProjectLocal({
      project_id: overrides.project_id ?? project,
      account_id: account,
      home_bay_id: "bay-0",
      now: overrides.now,
    });
  }

  async function issue(overrides: Record<string, unknown> = {}) {
    const { issueComputerTicket } = await import("./tickets");
    return await issueComputerTicket({
      account_id: account,
      agent_id: agent,
      run_id: run,
      source_project_id: project,
      run_expires_at: Date.now() + 3_600_000,
      computer: "mac",
      operation: "exec",
      request: { command: "docker ps" },
      operation_id: randomUUID(),
      pop_key: generateSigningKey().publicDer,
      attestation: await attestation(),
      ...overrides,
    } as any);
  }

  it("issues a signed ticket the daemon admits, and records the operation first", async () => {
    const operation_id = randomUUID();
    const result: any = await issue({ operation_id });
    const ticket = result.ticket;
    const { trustedSigningKeys } = await import("./signing-keys");
    const keys = await trustedSigningKeys();
    expect(
      verifyEnvelope(SIGNED_KINDS.ticket, ticket, (kid) => keys.get(kid)),
    ).toBe(true);
    expect(
      verifyEnvelope(
        SIGNED_KINDS.attestation,
        ticket.payload.attestation,
        (kid) => keys.get(kid),
      ),
    ).toBe(true);
    const state: DaemonState = {
      site: "https://cocalc.ai",
      cluster_id: "standalone",
      computer_id,
      computer_key: machineKey,
      account_id: account,
      home_bay_id: "bay-0",
      agent_network_id: network,
      ceiling_hash,
      policy_epoch: 0,
      floors: { home_epoch: 0, computer_epoch: 1, projects: { [project]: 5 } },
    };
    expect(
      ticketRefusals(ticket.payload, state, {
        hub_now: Date.now(),
        since_receipt_ms: 5,
      }),
    ).toEqual([]);
    expect(ticket.payload.start_by).toBeLessThanOrEqual(
      ticket.payload.attestation.payload.not_after,
    );
    const { rows } = await db().query(
      "SELECT state, command, request_hash FROM account_computer_operations WHERE operation_id=$1",
      [operation_id],
    );
    expect(rows[0]).toMatchObject({
      state: "issued",
      command: "docker ps",
      request_hash: ticket.payload.request_hash,
    });
  });

  it("a retry with the same operation_id gets a new ticket for the same operation", async () => {
    const operation_id = randomUUID();
    const pop_key = generateSigningKey().publicDer;
    const first: any = await issue({ operation_id, pop_key });
    const second: any = await issue({ operation_id, pop_key });
    expect(second.ticket.payload.ticket_id).not.toBe(
      first.ticket.payload.ticket_id,
    );
    expect(second.ticket.payload.request_hash).toBe(
      first.ticket.payload.request_hash,
    );
    const { rows } = await db().query(
      "SELECT count(*)::int AS n FROM account_computer_operations",
    );
    expect(rows[0].n).toBe(1);
    await expect(
      issue({ operation_id, pop_key, request: { command: "rm -rf /" } }),
    ).rejects.toThrow(/different request/);
  });

  it("a finished operation, or one whose outcome is unknown, is never ticketed again", async () => {
    for (const state of ["done", "unknown"]) {
      const operation_id = randomUUID();
      const pop_key = generateSigningKey().publicDer;
      await issue({ operation_id, pop_key });
      await db().query(
        "UPDATE account_computer_operations SET state=$2, exit_code=$3 WHERE operation_id=$1",
        [operation_id, state, state === "done" ? 0 : null],
      );
      expect(await issue({ operation_id, pop_key })).toEqual({
        finished: { state, exit_code: state === "done" ? 0 : null },
      });
    }
  });

  it("a retry must come from the same agent, run, project, thread and PoP key", async () => {
    // Another member of the network, in another eligible project.
    const other = randomUUID();
    const otherProject = randomUUID();
    await db().query(
      `INSERT INTO agent_network_members
         (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
       VALUES ($1,'registered',$2,$2,$3,$4)`,
      [network, other, otherProject, account],
    );
    await db().query(
      `INSERT INTO projects (project_id, users, runtime_authority_revision) VALUES ($1,$2,5)`,
      [otherProject, JSON.stringify({ [account]: { group: "owner" } })],
    );
    const operation_id = randomUUID();
    const pop_key = generateSigningKey().publicDer;
    await issue({ operation_id, pop_key, thread_id: "t1" });
    for (const overrides of [
      {
        agent_id: other,
        source_project_id: otherProject,
        attestation: await attestation({ project_id: otherProject }),
      },
      { run_id: randomUUID() },
      { thread_id: "t2" },
      { thread_id: null },
      { pop_key: generateSigningKey().publicDer },
    ]) {
      await expect(
        issue({ operation_id, pop_key, thread_id: "t1", ...overrides }),
      ).rejects.toThrow(/different request/);
    }
    await expect(
      issue({ operation_id, pop_key, thread_id: "t1" }),
    ).resolves.toHaveProperty("ticket");
  });

  it("logs and kill only for the agent's own job, ops only for its own operations here", async () => {
    const other = randomUUID();
    await db().query(
      `INSERT INTO agent_network_members
         (agent_network_id, member_kind, member_id, registered_agent_id, project_id, added_by)
       VALUES ($1,'registered',$2,$2,$3,$4)`,
      [network, other, project, account],
    );
    const job_id = randomUUID();
    await issue({
      operation_id: job_id,
      operation: "run",
      request: { command: "sleep 100", description: "a job" },
    });
    for (const [operation, request] of [
      ["logs", { job_id }],
      ["kill", { job_id }],
      ["ops", { operation_id: job_id }],
    ] as const) {
      await expect(
        issue({ agent_id: other, operation, request }),
      ).rejects.toThrow(/no such (job|operation) of yours/);
      await expect(issue({ operation, request })).resolves.toHaveProperty(
        "ticket",
      );
    }
    // An exec is not a job.
    const exec_id = randomUUID();
    await issue({ operation_id: exec_id });
    await expect(
      issue({ operation: "kill", request: { job_id: exec_id } }),
    ).rejects.toThrow(/no such job of yours/);
    await expect(
      issue({ operation: "logs", request: { job_id: randomUUID() } }),
    ).rejects.toThrow(/no such job of yours/);
  });

  it.each<[string, () => Promise<Record<string, unknown>>, RegExp]>([
    ["an unknown computer", async () => ({ computer: "nope" }), /no computer/],
    [
      "an agent outside the network",
      async () => ({ agent_id: randomUUID() }),
      /not in the agent network/,
    ],
    [
      "the agent from another project",
      async () => ({ source_project_id: randomUUID() }),
      /another project/,
    ],
    [
      "an expired run",
      async () => ({ run_expires_at: Date.now() - 1 }),
      /run has expired/,
    ],
    [
      "a bad PoP key",
      async () => ({ pop_key: generateAgreementKey().publicDer }),
      /Ed25519/,
    ],
    [
      "a request with unknown fields",
      async () => ({ request: { command: "ls", sudo: true } }),
      /unknown field/,
    ],
    [
      "a job without a description",
      async () => ({ operation: "run", request: { command: "make" } }),
      /description/,
    ],
  ])("refuses %s", async (_label, overrides, reason) => {
    await expect(issue(await overrides())).rejects.toThrow(reason);
  });

  it("refuses an attestation that is expired, forged, or for an ineligible project", async () => {
    const old = await attestation({ now: Date.now() - 60_000 });
    await expect(issue({ attestation: old })).rejects.toThrow(/expired/);
    const genuine = await attestation();
    const forged = signEnvelope(
      SIGNED_KINDS.attestation,
      genuine.payload,
      generateSigningKey(),
    );
    await expect(issue({ attestation: forged })).rejects.toThrow(/trusted bay/);
    await db().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project,
      JSON.stringify({
        [account]: { group: "owner" },
        [randomUUID()]: { group: "collaborator" },
      }),
    ]);
    await expect(issue({ attestation: await attestation() })).rejects.toThrow(
      /only collaborator is you/,
    );
  });

  it("refuses an attestation from a bay that no longer owns the project, or dated in the future", async () => {
    const genuine = await attestation();
    await db().query(
      "UPDATE projects SET owning_bay_id='bay-7' WHERE project_id=$1",
      [project],
    );
    await expect(issue({ attestation: genuine })).rejects.toThrow(
      /not from the project's current bay/,
    );
    await db().query(
      "UPDATE projects SET owning_bay_id=NULL WHERE project_id=$1",
      [project],
    );
    const { signAsBay } = await import("./signing-keys");
    const future = await signAsBay(SIGNED_KINDS.attestation, {
      ...genuine.payload,
      issued_at: Date.now() + 20_000,
      not_after: Date.now() + 40_000,
    });
    await expect(issue({ attestation: future })).rejects.toThrow(
      /dated in the future/,
    );
  });

  it("refuses a revoked computer, an ended session, a paused network, a removed member, paused agent messaging", async () => {
    const { revokeComputer } = await import("./computers");
    await db().query("UPDATE account_computers SET deadline=$1", [
      new Date(Date.now() - 1),
    ]);
    await expect(issue()).rejects.toThrow(/session on mac has ended/);
    await db().query("UPDATE account_computers SET deadline=$1", [
      new Date(Date.now() + 3_600_000),
    ]);
    await db().query("UPDATE agent_networks SET state='paused'");
    await expect(issue()).rejects.toThrow(/not in the agent network/);
    await db().query("UPDATE agent_networks SET state='active'");
    await db().query("UPDATE agent_network_members SET removed_at=now()");
    await expect(issue()).rejects.toThrow(/not in the agent network/);
    await db().query("UPDATE agent_network_members SET removed_at=NULL");
    await db().query(
      `INSERT INTO agent_personal_controls(account_id, paused) VALUES ($1, true)
       ON CONFLICT (account_id) DO UPDATE SET paused=true`,
      [account],
    );
    await expect(issue()).rejects.toThrow(/agent messaging is paused/);
    await db().query("UPDATE agent_personal_controls SET paused=false");
    await expect(issue()).resolves.toHaveProperty("ticket");
    await revokeComputer({ account_id: account, computer_id });
    await expect(issue()).rejects.toThrow(/disconnected/);
  });

  it("rate-limits an agent run, counting every ticket, retries included", async () => {
    const { MAX_TICKETS_PER_RUN_PER_MINUTE } = await import("./tickets");
    const operation_id = randomUUID();
    const pop_key = generateSigningKey().publicDer;
    await issue({ operation_id, pop_key });
    await db().query(
      `INSERT INTO account_computer_ticket_log (ticket_id, account_id, computer_id, run_id, issued_at)
       SELECT gen_random_uuid(), $1, $2, $3, now() FROM generate_series(1, $4)`,
      [account, computer_id, run, MAX_TICKETS_PER_RUN_PER_MINUTE - 2],
    );
    // One more retry of the same operation is still a ticket...
    await expect(issue({ operation_id, pop_key })).resolves.toHaveProperty(
      "ticket",
    );
    // ...and then the run is out of tickets, retries too.
    await expect(issue({ operation_id, pop_key })).rejects.toThrow(
      /too many operations from this agent run/,
    );
    await expect(issue()).rejects.toThrow(
      /too many operations from this agent run/,
    );
  });

  it("refuses everything while the account is being rehomed", async () => {
    await db().query(
      `CREATE TABLE IF NOT EXISTS account_rehome_operations
         (op_id TEXT, account_id UUID, source_bay_id TEXT, dest_bay_id TEXT,
          stage TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
    );
    try {
      await db().query(
        `INSERT INTO account_rehome_operations VALUES ('op1',$1,'bay-0','bay-1','copy','running',now())`,
        [account],
      );
      await expect(issue()).rejects.toThrow(/account rehome op1 is running/);
    } finally {
      await db().query("DROP TABLE account_rehome_operations");
    }
  });

  it("refuses at a bay that is not the account's home", async () => {
    await db().query(
      "UPDATE accounts SET home_bay_id='bay-9' WHERE account_id=$1",
      [account],
    );
    await expect(issue()).rejects.toThrow(/account is homed on bay-9/);
  });
});
