/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// End to end, in one process: a real conat server with CoCalc's own
// getUser/isAllowed, a paired computer running the connector (daemon and
// session loop), and the hub's relay carrying a ticketed exec to it and the
// answer back. Real SQL (PGlite): run with COCALC_TEST_USE_PGLITE=1.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { io as socketIoClient } from "socket.io-client";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import { parseOperationRequest } from "@cocalc/util/computers/operations";
import {
  parseComputerTicket,
  parsePairingTranscript,
  parseProjectAttestation,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  requestHash,
  signEnvelope,
  signProofOfPossession,
  type KeyPair,
} from "@cocalc/backend/computers/crypto";
import {
  signChallengeRequest,
  signComputerLogin,
} from "@cocalc/backend/computers/login";
import { DaemonStore } from "@cocalc/backend/computers/daemon/state";
import {
  OP_RECEIVE_LIMITS,
  runConnector,
  type Connection,
} from "@cocalc/backend/computers/connector";
import { initConatServer } from "@cocalc/backend/conat/test/setup";
import { connect } from "@cocalc/conat/core/client";
import {
  computerOpSubject,
  computerReplySubject,
} from "@cocalc/conat/computers/subjects";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";

jest.setTimeout(60_000);

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
  // Plain site settings (the computers switch) pass through unchanged.
  decryptSettingValue: async (_name: string, value: string) => ({
    value,
    needsMigration: false,
  }),
  encryptSettingValue: async (_name: string, value: string) => value,
}));
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: async () => "https://cocalc.ai",
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "account_computers",
  "account_computer_session_targets",
  "account_computer_requests",
  "account_computer_operations",
  "account_computer_challenges",
  "account_computer_sessions",
  "account_computer_relays",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "agent_network_members",
  "accounts",
  "server_settings",
];

async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describeDb("a computer connected over conat", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();
  const agent = randomUUID();
  const run = randomUUID();
  const project = randomUUID();
  const policy = parseComputerPolicy({
    version: 1,
    mode: "direct",
    duration: null,
    lease_hours: 24,
    agent_network_id: network,
    network: "on",
    gpu: true,
    mounts: [],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  });
  let server;
  let hub;
  let dir: string;
  let stop: AbortController;
  let connector: Promise<void>;
  let computer_id: string;
  let computerKey: KeyPair;
  let certificate: any;
  let sessions: string[] = [];
  let address: string;
  const inboxChecks: string[] = [];

  async function setComputersEnabled(on: boolean) {
    await db().query(
      "DELETE FROM server_settings WHERE name='computers_enabled'",
    );
    if (on) {
      await db().query(
        "INSERT INTO server_settings (name, value) VALUES ('computers_enabled','yes')",
      );
    }
    const { resetServerSettingsCache } =
      await import("@cocalc/database/settings/server-settings");
    resetServerSettingsCache();
  }

  /**
   * The newest session, once its daemon has applied the computer's state
   * (delivery runs here as on a hub): only then do operations reach it.
   */
  async function session(): Promise<string> {
    const { currentSession } = await import("./sessions");
    await until(
      async () =>
        sessions.length > 0 &&
        (await currentSession(computer_id))?.session_id ===
          sessions[sessions.length - 1],
      15_000,
    );
    return sessions[sessions.length - 1];
  }

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
    await setComputersEnabled(true);
    await db().query(
      `INSERT INTO agent_networks
         (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
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
      `INSERT INTO accounts (account_id, first_name, last_name, email_address, created)
       VALUES ($1,'Ada','Lovelace','ada@example.org',now())`,
      [account],
    );
    const auth = await import("../conat/socketio/auth");
    server = await initConatServer({
      getUser: auth.getUser,
      isAllowed: async (opts) => {
        if (
          (opts.user as any)?.auth_actor === "computer" &&
          opts.subject.startsWith("_INBOX")
        ) {
          inboxChecks.push(opts.subject);
        }
        return await auth.isAllowed(opts);
      },
      onDisconnect: auth.onUserDisconnect,
      systemAccountPassword: "secret",
      computerRevalidationMs: 500,
    });
    address = server.address();
    hub = connect({ address, systemAccountPassword: "secret", noCache: true });
    const { setRelayClientForTesting } = await import("./relay");
    setRelayClientForTesting(hub);
    const delivery = await import("./delivery");
    delivery.setDeliveryClientForTesting(hub);
    delivery.startComputerStateDelivery();

    // Pair (the HTTP endpoints are covered elsewhere).
    const r = await import("./requests");
    const { request_id } = await r.createComputerRequest({
      account_id: account,
      name: "m1",
      requested_policy: policy,
    });
    const view = await r.getPairingView(request_id);
    computerKey = generateSigningKey();
    const transcript = parsePairingTranscript({
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: account,
      policy_hash: policyHash(policy),
      signing_key: computerKey.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "m1", os: "darwin", arch: "arm64", user: "sage" },
    });
    const { transcript_hash } = await r.submitPairing({
      request_id,
      transcript: signEnvelope(
        SIGNED_KINDS.transcript,
        transcript,
        computerKey,
      ),
      signing_public_key: computerKey.publicDer,
      resolved_policy: policy,
    });
    const generation = (
      await db().query(
        "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
        [network],
      )
    ).rows[0].generation;
    ({ computer_id } = await r.approveComputerRequest({
      account_id: account,
      request_id,
      transcript_hash,
      agent_network_generation: generation,
    }));
    const status = await r.getPairingStatus({ request_id, transcript_hash });
    certificate = status.certificate;

    dir = mkdtempSync(join(tmpdir(), "computer-"));
    DaemonStore.create(join(dir, "state"), {
      certificate: status.certificate,
      ceiling: status.policy,
      directory: status.directory!,
      computer_key: computerKey.fingerprint,
      agent_network_id: network,
    });
    const connection: Connection = {
      dir,
      origin: "https://cocalc.ai",
      computer_id,
      name: "m1",
      key: computerKey,
      duration: null,
      lease_hours: 24,
    };
    const { createLoginChallenge } = await import("./sessions");
    stop = new AbortController();
    connector = runConnector({
      connection,
      io: { log: () => {}, confirm: async () => true },
      signal: stop.signal,
      challenge: () =>
        createLoginChallenge(
          signChallengeRequest({ certificate, key: computerKey }),
        ),
      openConat: (auth) =>
        connect({
          address,
          noCache: true,
          reconnection: false,
          disableInbox: true,
          auth,
        } as any),
      onSession: (id) => sessions.push(id),
    });
    await session();
  });

  afterAll(async () => {
    (await import("./delivery")).stopComputerStateDelivery();
    stop?.abort();
    await connector?.catch(() => {});
    hub?.close();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A ticket and the operation row exactly as issueComputerTicket records
   * them (issuance itself, with attestation, is tested elsewhere).
   */
  async function ticketFor(
    operation: "exec" | "info",
    raw: unknown,
    opts: { operation_id?: string; pop?: KeyPair } = {},
  ) {
    const { getBaySigningKey } = await import("./signing-keys");
    const signer = await getBaySigningKey();
    const now = Date.now();
    const op = parseOperationRequest(operation, raw);
    const attestation = signEnvelope(
      SIGNED_KINDS.attestation,
      parseProjectAttestation({
        type: "cocalc-project-attestation",
        version: 1,
        site: "https://cocalc.ai",
        cluster_id: getConfiguredClusterId(),
        project_id: project,
        project_bay_id: getConfiguredBayId(),
        eligible: true,
        privacy_epoch: 1,
        account_id: account,
        home_bay_id: getConfiguredBayId(),
        issued_at: now,
        not_after: now + 30_000,
      }),
      signer,
    );
    const pop = opts.pop ?? generateSigningKey();
    const c = (
      await db().query(
        "SELECT epoch, policy_epoch, signing_key FROM account_computers WHERE computer_id=$1",
        [computer_id],
      )
    ).rows[0];
    const operation_id = opts.operation_id ?? randomUUID();
    const ticket = signEnvelope(
      SIGNED_KINDS.ticket,
      parseComputerTicket({
        type: "cocalc-computer-ticket",
        version: 1,
        ticket_id: randomUUID(),
        operation_id,
        operation,
        request_hash: requestHash(op),
        site: "https://cocalc.ai",
        cluster_id: getConfiguredClusterId(),
        issuer_bay_id: getConfiguredBayId(),
        home_epoch: 0,
        computer_id,
        computer_key: c.signing_key,
        account_id: account,
        agent_id: agent,
        agent_network_id: network,
        source_project_id: project,
        attestation,
        computer_epoch: Number(c.epoch),
        policy_epoch: Number(c.policy_epoch),
        ceiling_hash: policyHash(policy),
        run_id: run,
        run_expires_at: now + 3_600_000,
        pop_key: pop.publicDer,
        issued_at: now,
        start_by: now + 30_000,
        max_runtime_ms: 60_000,
        limits: { max_bytes: null, concurrency: 4 },
      }),
      signer,
    );
    const t = ticket.payload;
    await db().query(
      `INSERT INTO account_computer_operations
         (computer_id, operation_id, account_id, agent_id, run_id,
          source_project_id, operation, request_hash, ticket_id, pop_key,
          state, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'issued',now())
       ON CONFLICT (computer_id, operation_id)
       DO UPDATE SET ticket_id=EXCLUDED.ticket_id`,
      [
        computer_id,
        operation_id,
        account,
        agent,
        run,
        project,
        operation,
        t.request_hash,
        t.ticket_id,
        pop.publicDer,
      ],
    );
    return {
      ticket,
      proof: signProofOfPossession(pop, t.ticket_id, t.request_hash),
      request: op.request,
      pop,
    };
  }

  const relay = async (t: { ticket; proof; request }, extra: object = {}) => {
    const { relayToComputer } = await import("./relay");
    return await relayToComputer({
      account_id: account,
      agent_id: agent,
      run_id: run,
      source_project_id: project,
      ticket: t.ticket,
      proof: t.proof,
      request: t.request,
      ...extra,
    });
  };

  it("relays a ticketed exec to the computer and brings back its output", async () => {
    const result: any = await relay(
      await ticketFor("exec", { command: "echo hello from $((6*7))" }),
    );
    expect(result.answered).toBe(true);
    expect(result.reply).toMatchObject({ ok: true, state: "done" });
    expect(result.reply.result).toMatchObject({
      exit_code: 0,
      stdout: "hello from 42\n",
    });
    const relays = await db().query(
      "SELECT state FROM account_computer_relays WHERE computer_id=$1",
      [computer_id],
    );
    expect(relays.rows.map((r) => r.state)).toEqual(["answered"]);
    // The connector never tried to use an inbox.
    expect(inboxChecks).toEqual([]);
  });

  it("runs an argv exactly as given, through ticket and relay", async () => {
    const argv = ["sh", "-c", "printf '%s|' \"$@\"", "x", "a\\\\b", "it's"];
    const result: any = await relay(await ticketFor("exec", { argv }));
    expect(result.reply).toMatchObject({ ok: true, state: "done" });
    expect(result.reply.result).toMatchObject({
      exit_code: 0,
      stdout: "a\\\\b|it's|",
    });
  });

  it("refuses another run's ticket, a forged one, another request, a bad proof, and a superseded ticket", async () => {
    const t = await ticketFor("exec", { command: "true" });
    await expect(relay(t, { run_id: randomUUID() })).rejects.toThrow(
      /another agent/,
    );
    await expect(relay(t, { source_project_id: randomUUID() })).rejects.toThrow(
      /another agent/,
    );
    const forged = signEnvelope(
      SIGNED_KINDS.ticket,
      t.ticket.payload,
      generateSigningKey(),
    );
    await expect(relay({ ...t, ticket: forged })).rejects.toThrow(
      /not issued here/,
    );
    await expect(
      relay({ ...t, request: { ...t.request, command: "rm -rf ~" } }),
    ).rejects.toThrow(/does not match/);
    await expect(
      relay({
        ...t,
        proof: signProofOfPossession(
          generateSigningKey(),
          t.ticket.payload.ticket_id,
          t.ticket.payload.request_hash,
        ),
      }),
    ).rejects.toThrow(/proof of possession/);
    // A retry got a newer ticket: the old one is dead.
    const newer = await ticketFor(
      "exec",
      { command: "true" },
      { operation_id: t.ticket.payload.operation_id, pop: t.pop },
    );
    await expect(relay(t)).rejects.toThrow(/newer ticket/);
    expect(((await relay(newer)) as any).answered).toBe(true);
    // Nothing above reached the computer except the last.
    const rows = await db().query(
      "SELECT count(*)::int AS n FROM account_computer_relays WHERE operation_id=$1",
      [t.ticket.payload.operation_id],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("one open relay per operation: a concurrent duplicate is refused, not re-sent", async () => {
    const t = await ticketFor("exec", { command: "sleep 1; echo once" });
    const first = relay(t);
    await until(async () => {
      const r = await db().query(
        "SELECT 1 FROM account_computer_relays WHERE operation_id=$1 AND state='dispatched'",
        [t.ticket.payload.operation_id],
      );
      return r.rows.length > 0;
    });
    await expect(relay(t)).rejects.toThrow(/already being relayed/);
    expect(((await first) as any).reply.result.stdout).toBe("once\n");
  });

  it("a command longer than the relay's wait: asking again with the same operation reports it running, then returns its output once done (never runs it twice)", async () => {
    const first = await ticketFor("exec", {
      command: "sleep 2; echo late >> runs.txt; echo late",
      cwd: null,
    });
    const op = {
      operation_id: first.ticket.payload.operation_id,
      pop: first.pop,
    };
    expect(await relay(first, { waitMs: 300 })).toMatchObject({
      answered: false,
    });
    const again = await ticketFor(
      "exec",
      { command: "sleep 2; echo late >> runs.txt; echo late", cwd: null },
      op,
    );
    const running: any = await relay(again);
    expect(running.reply).toMatchObject({ ok: true, replayed: true });
    expect(["admitted", "running"]).toContain(running.reply.state);
    await new Promise((r) => setTimeout(r, 2500));
    const last = await ticketFor(
      "exec",
      { command: "sleep 2; echo late >> runs.txt; echo late", cwd: null },
      op,
    );
    const done: any = await relay(last);
    expect(done.reply).toMatchObject({
      ok: true,
      replayed: true,
      state: "done",
    });
    expect(done.reply.result.stdout).toBe("late\n");
    // Ran exactly once on the machine.
    const count = await ticketFor("exec", {
      command: "wc -l < runs.txt; rm runs.txt",
    });
    expect(((await relay(count)) as any).reply.result.stdout.trim()).toBe("1");
  });

  it("an answer that never comes leaves the relay expired (outcome unknown), not answered", async () => {
    const t = await ticketFor("exec", { command: "sleep 3" });
    const result: any = await relay(t, { waitMs: 500 });
    expect(result).toMatchObject({ answered: false, state: "dispatched" });
    const r = await db().query(
      "SELECT state FROM account_computer_relays WHERE operation_id=$1",
      [t.ticket.payload.operation_id],
    );
    expect(r.rows[0].state).toBe("expired");
  });

  it("the per-process waiter cap is reserved before any await: concurrent calls can't all slip past it", async () => {
    const { setMaxWaitersForTesting } = await import("./relay");
    setMaxWaitersForTesting(2);
    let release: () => void = () => {};
    const stalled = new Promise<void>((r) => (release = r));
    try {
      const tickets = await Promise.all(
        [0, 1, 2, 3].map(() => ticketFor("exec", { command: "true" })),
      );
      // The first stalls inside its transaction, holding everything after.
      const calls = tickets.map((t, i) =>
        relay(t, i === 0 ? { beforeCommit: () => stalled } : {}),
      );
      const settled = Promise.allSettled(calls);
      await new Promise((r) => setTimeout(r, 300));
      release();
      const results = await settled;
      const busy = results.filter(
        (r) => r.status === "rejected" && /busy/.test(`${r.reason}`),
      );
      expect(busy).toHaveLength(2);
      // Refused calls never reached the database.
      const rows = await db().query(
        "SELECT count(*)::int AS n FROM account_computer_relays WHERE operation_id = ANY($1)",
        [tickets.map((t) => t.ticket.payload.operation_id)],
      );
      expect(rows.rows[0].n).toBe(2);
    } finally {
      setMaxWaitersForTesting(undefined);
      release();
    }
  });

  it("a relay that waited on locks longer than its wait still commits open, and a duplicate stays refused until it finishes", async () => {
    const t = await ticketFor("exec", { command: "sleep 1; echo slow" });
    const first = relay(t, {
      waitMs: 2500,
      // Authorization stalls longer than the wait itself.
      beforeCommit: () => new Promise((r) => setTimeout(r, 3000)),
    });
    let row: any;
    await until(async () => {
      row = (
        await db().query(
          "SELECT state, expires_at FROM account_computer_relays WHERE operation_id=$1",
          [t.ticket.payload.operation_id],
        )
      ).rows[0];
      return row != null;
    }, 10_000);
    expect(row.state).toBe("dispatched");
    expect(new Date(row.expires_at).valueOf()).toBeGreaterThan(
      Date.now() + 1000,
    );
    await expect(relay(t)).rejects.toThrow(/already being relayed/);
    // (Under PGlite the stalled transaction holds the only connection, so
    // the router's bounded revalidation drops the computer's session; then
    // activation refuses and nothing is published: "not sent".)
    const result: any = await first.catch((err) => err);
    if (result instanceof Error) {
      expect(result.message).toMatch(/not sent/);
    } else {
      expect([true, false]).toContain(result.answered);
    }
    // The computer logs in again before the next test.
    const { currentSession } = await import("./sessions");
    await until(
      async () => (await currentSession(computer_id)) != null,
      15_000,
    );
  });

  it("neither a late commit acknowledgement nor a stalled subscribe/publish lets a duplicate in: exactly one publish", async () => {
    const { setRelayClientForTesting } = await import("./relay");
    let publishes = 0;
    let stall = 0;
    const slow = new Proxy(hub, {
      get(target, prop) {
        if (prop === "subscribe" || prop === "publish") {
          return async (...args) => {
            await new Promise((r) => setTimeout(r, stall));
            if (prop === "publish") publishes += 1;
            return await target[prop](...args);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    setRelayClientForTesting(slow as any);
    try {
      for (const where of ["commit ack", "subscribe and publish"]) {
        publishes = 0;
        const t = await ticketFor("exec", { command: `echo ${where.length}` });
        let duplicate: unknown;
        const tryDuplicate = async () => {
          duplicate = await relay(t).catch((err) => err);
        };
        stall = where === "commit ack" ? 0 : 6000;
        const first = relay(t, {
          // Well past the old 5 s margin.
          afterCommit:
            where === "commit ack"
              ? async () => {
                  await new Promise((r) => setTimeout(r, 6000));
                  await tryDuplicate();
                }
              : undefined,
        });
        if (where !== "commit ack") {
          await new Promise((r) => setTimeout(r, 6500));
          stall = 0;
          await tryDuplicate();
        }
        const result: any = await first;
        expect(`${duplicate}`).toMatch(/already being relayed/);
        expect(result.reply.result.stdout).toBe(`${where.length}\n`);
        expect(publishes).toBe(1);
      }
    } finally {
      setRelayClientForTesting(hub);
    }
  });

  it("a reservation that lapsed before activation publishes nothing", async () => {
    const { setRelayClientForTesting } = await import("./relay");
    let publishes = 0;
    setRelayClientForTesting({
      subscribe: hub.subscribe.bind(hub),
      publish: async () => {
        publishes += 1;
        return { count: 1 };
      },
    } as any);
    try {
      const t = await ticketFor("exec", { command: "true" });
      await expect(
        relay(t, {
          afterCommit: async () => {
            await db().query(
              `UPDATE account_computer_relays SET expires_at=now() - interval '1 second'
                WHERE operation_id=$1`,
              [t.ticket.payload.operation_id],
            );
          },
        }),
      ).rejects.toThrow(/not sent/);
      expect(publishes).toBe(0);
    } finally {
      setRelayClientForTesting(hub);
    }
  });

  it("finished relay rows older than a day are pruned inline", async () => {
    const old = randomUUID();
    await db().query(
      `INSERT INTO account_computer_relays
         (correlation, computer_id, account_id, session_id, ticket_id,
          operation_id, request_hash, epoch, hub_process, state, created_at,
          expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'h',1,'p','answered',
               now() - interval '3 days', now() - interval '3 days')`,
      [old, computer_id, account, randomUUID(), randomUUID(), randomUUID()],
    );
    await relay(await ticketFor("exec", { command: "true" }));
    const r = await db().query(
      "SELECT 1 FROM account_computer_relays WHERE correlation=$1",
      [old],
    );
    expect(r.rows).toHaveLength(0);
  });

  it("a transport failure after commit is the explicit unknown outcome, and the row is expired", async () => {
    const { setRelayClientForTesting } = await import("./relay");
    const t = await ticketFor("exec", { command: "true" });
    setRelayClientForTesting({
      subscribe: async () => {
        throw new Error("conat is down");
      },
    } as any);
    try {
      const result: any = await relay(t);
      expect(result).toMatchObject({ answered: false, state: "dispatched" });
    } finally {
      setRelayClientForTesting(hub);
    }
    const r = await db().query(
      "SELECT state FROM account_computer_relays WHERE operation_id=$1",
      [t.ticket.payload.operation_id],
    );
    expect(r.rows[0].state).toBe("expired");
  });

  it("the stored summary of an answer is fixed-type and bounded, whatever the computer sends", async () => {
    const { summary, MAX_SUMMARY_BYTES } = await import("./relay");
    const huge = "x".repeat(1_000_000);
    for (const reply of [
      { ok: huge, state: huge, replayed: { nested: huge }, refused: [huge] },
      {
        ok: true,
        state: "done",
        replayed: false,
        refused: Array(1000).fill(huge),
      },
      {
        ok: [huge],
        state: { a: huge },
        replayed: [huge],
        refused: { a: huge },
      },
      { refused: [{ toString: () => huge }, 5, null] },
      null,
      huge,
    ]) {
      const s = summary(reply);
      expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(
        MAX_SUMMARY_BYTES,
      );
      expect([true, false, null]).toContain(s.ok);
      expect([true, false, null]).toContain(s.replayed);
      expect(s.state == null || /^[a-z_]{1,20}$/.test(s.state)).toBe(true);
    }
    expect(
      summary({ ok: true, state: "done", replayed: false, refused: null }),
    ).toEqual({ ok: true, state: "done", replayed: false, refused: null });
  });

  it("raw limits apply before reassembly in both directions", async () => {
    const { REPLY_RECEIVE_LIMITS } = await import("./relay");
    for (const limits of [REPLY_RECEIVE_LIMITS, OP_RECEIVE_LIMITS]) {
      const subject = `hub.computer.${randomUUID()}.reply.v1.limits-test`;
      const sub = await hub.subscribe(subject, { receiveLimits: limits });
      const got: number[] = [];
      void (async () => {
        for await (const m of sub) got.push(m.data.length);
      })();
      const big = "x".repeat(limits.maxMessageBytes + 1024);
      await hub.publish(subject, big);
      await hub.publish(subject, "small");
      await until(() => got.length > 0);
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual([5]);
      sub.close();
    }
  });

  it("a computer socket may only publish/subscribe: no cluster, RPC or interest events", async () => {
    const { createLoginChallenge } = await import("./sessions");
    const challenge = await createLoginChallenge(
      signChallengeRequest({ certificate, key: computerKey }),
    );
    const login = signComputerLogin({
      challenge,
      certificate: (
        await db().query(
          "SELECT certificate FROM account_computers WHERE computer_id=$1",
          [computer_id],
        )
      ).rows[0].certificate,
      key: computerKey,
    });
    const u = new URL(address);
    const socket = socketIoClient(u.origin, {
      path: `${u.pathname.replace(/\/$/, "")}/conat`,
      transports: ["websocket"],
      reconnection: false,
      auth: { computer_login: login },
    });
    try {
      await new Promise((resolve) => socket.once("info", resolve));
      for (const event of [
        "cluster",
        "rpc",
        "fast-rpc",
        "rpc-service",
        "wait-for-interest",
        "rpc-raw-response",
      ]) {
        const answer: any = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve("no answer"), 2000);
          socket.emit(event, {}, (x) => {
            clearTimeout(timer);
            resolve(x);
          });
        });
        expect(answer).toMatchObject({ code: 403 });
      }
    } finally {
      socket.close();
    }
  });

  it("narrowing the network refuses an old ticket, cuts the session, and the computer comes back at the new epoch", async () => {
    const old = await ticketFor("exec", { command: "echo before" });
    const before = await session();
    const { bumpComputersForNetwork } = await import("./computers");
    await bumpComputersForNetwork(db(), account, network);
    await expect(relay(old)).rejects.toThrow(/stale/);
    // The router drops the old session's socket; the connector logs in again.
    await until(async () => (await session()) !== before, 15_000);
    const fresh = await ticketFor("exec", { command: "echo after" });
    await until(async () => {
      try {
        const r: any = await relay(fresh);
        return r.reply?.result?.stdout === "after\n";
      } catch (err) {
        if (/not connected/.test(`${err}`)) return false;
        throw err;
      }
    }, 15_000);
  });

  it("turning the site's computers switch off cuts the session and refuses new logins; turned on again, the computer comes back", async () => {
    const before = await session();
    const count = sessions.length;
    await setComputersEnabled(false);
    // The router's next check closes the session...
    await until(async () => {
      const { rows } = await db().query(
        "SELECT closed_at FROM account_computer_sessions WHERE session_id=$1",
        [before],
      );
      return rows[0]?.closed_at != null;
    }, 15_000);
    // ...a challenge is refused, and the connector's retries don't get in.
    const { sessionChallenge } = await import("./pairing-http");
    const { COMPUTERS_DISABLED } = await import("./enabled");
    expect(
      await sessionChallenge(
        { request: signChallengeRequest({ certificate, key: computerKey }) },
        "198.51.100.20",
      ),
    ).toEqual({ error: COMPUTERS_DISABLED });
    await new Promise((r) => setTimeout(r, 2000));
    expect(sessions.length).toBe(count);
    await setComputersEnabled(true);
    await until(async () => (await session()) !== before, 30_000);
  });

  it("an agent removed from the network can't relay, even with a current ticket", async () => {
    const t = await ticketFor("exec", { command: "true" });
    await db().query(
      "UPDATE agent_network_members SET removed_at=now() WHERE registered_agent_id=$1",
      [agent],
    );
    try {
      await expect(relay(t)).rejects.toThrow(/not in the agent network/);
    } finally {
      await db().query(
        "UPDATE agent_network_members SET removed_at=NULL WHERE registered_agent_id=$1",
        [agent],
      );
    }
  });

  it("an account can't publish to the computer or read its replies", async () => {
    const { isAllowed } = await import("../conat/socketio/auth");
    const id = await session();
    const user = { account_id: account };
    // A positive control: this account principal is otherwise working.
    expect(
      await isAllowed({
        user,
        subject: `hub.account.${account}.api`,
        type: "pub",
      }),
    ).toBe(true);
    const op = computerOpSubject(computer_id, id);
    const reply = computerReplySubject(computer_id, id, "h", "c");
    for (const [subject, type] of [
      [op, "pub"],
      [op, "sub"],
      [reply, "sub"],
      [reply, "pub"],
      [`computer.${computer_id}.>`, "sub"],
      [`hub.computer.${computer_id}.>`, "sub"],
    ] as const) {
      expect(await isAllowed({ user, subject, type })).toBe(false);
    }
  });

  it("the computer principal: exact fields only, its own session, and not after revocation; disconnect closes the session", async () => {
    const { isAllowed, asComputerUser } =
      await import("../conat/socketio/auth");
    const id = await session();
    const row = (
      await db().query(
        "SELECT generation, epoch FROM account_computer_sessions WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    const user: any = {
      auth_actor: "computer",
      computer_id,
      computer_account_id: account,
      computer_session_id: id,
      computer_generation: Number(row.generation),
      computer_epoch: Number(row.epoch),
      auth_lease_exp_s: Date.now() / 1000 + 600,
    };
    expect(asComputerUser(user)).toBeDefined();
    const op = computerOpSubject(computer_id, id);
    const reply = computerReplySubject(computer_id, id, "h", "c");
    expect(await isAllowed({ user, subject: op, type: "sub" })).toBe(true);
    expect(await isAllowed({ user, subject: reply, type: "pub" })).toBe(true);
    for (const [subject, type] of [
      [op, "pub"],
      [`_INBOX.x`, "pub"],
      [`_INBOX.x`, "sub"],
      [`hub.account.${account}.api`, "pub"],
      [`project.${project}.x`, "pub"],
      [`public.x`, "sub"],
      [`>`, "sub"],
    ] as const) {
      expect(await isAllowed({ user, subject, type })).toBe(false);
    }
    // Any extra authority-bearing field: not a computer, allowed nothing.
    for (const extra of [
      { account_id: account },
      { hub_id: "hub" },
      { auth_scopes: ["project_session"] },
      { auth_method: "api_key" },
    ]) {
      expect(asComputerUser({ ...user, ...extra })).toBeUndefined();
      expect(
        await isAllowed({
          user: { ...user, ...extra },
          subject: op,
          type: "sub",
        }),
      ).toBe(false);
    }
    // Revoked: everything stops, and the relay refuses.
    const t = await ticketFor("exec", { command: "true" });
    const { revokeComputer } = await import("./computers");
    await revokeComputer({ account_id: account, computer_id });
    expect(await isAllowed({ user, subject: op, type: "sub" })).toBe(false);
    expect(await isAllowed({ user, subject: "", type: "sub" })).toBe(false);
    await expect(relay(t)).rejects.toThrow(/disconnected/);
    // The router drops the socket and its disconnect closes the session.
    await until(async () => {
      const r = await db().query(
        "SELECT closed_at FROM account_computer_sessions WHERE session_id=$1",
        [id],
      );
      return r.rows[0]?.closed_at != null;
    }, 10_000);
  });
});

describe("a computer socket whose revalidation hangs", () => {
  it("is disconnected (fail closed), not kept until its lease", async () => {
    const user = {
      auth_actor: "computer",
      computer_id: randomUUID(),
      computer_account_id: randomUUID(),
      computer_session_id: randomUUID(),
      computer_generation: 1,
      computer_epoch: 1,
      auth_lease_exp_s: Date.now() / 1000 + 600,
    };
    let hang = false;
    const server = await initConatServer({
      getUser: async () => user as any,
      isAllowed: async () => {
        if (hang) await new Promise(() => {});
        return true;
      },
      computerRevalidationMs: 300,
    });
    const u = new URL(server.address());
    const socket = socketIoClient(u.origin, {
      path: `${u.pathname.replace(/\/$/, "")}/conat`,
      transports: ["websocket"],
      reconnection: false,
    });
    try {
      await new Promise((resolve) => socket.once("info", resolve));
      await new Promise((r) => setTimeout(r, 700));
      expect(socket.connected).toBe(true);
      hang = true;
      await until(() => !socket.connected, 3000);
    } finally {
      socket.close();
      await server.close();
    }
  });
});
