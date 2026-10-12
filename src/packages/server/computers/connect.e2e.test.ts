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
} from "@cocalc/backend/computers/crypto";
import { DaemonStore } from "@cocalc/backend/computers/daemon/state";
import {
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
  "account_computer_challenges",
  "account_computer_sessions",
  "account_computer_relays",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_networks",
  "accounts",
];

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
  let connected: Promise<string>;
  let connector: Promise<void>;
  let computer_id: string;
  let session_id: string;
  let address: string;

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
    await db().query(
      `INSERT INTO agent_networks
         (agent_network_id, account_id, title, state, delivery_mode, generation, created_by)
       VALUES ($1,$2,'lab','active','queued',$3,$2)`,
      [network, account, randomUUID()],
    );
    await db().query(
      `INSERT INTO accounts (account_id, first_name, last_name, email_address, created)
       VALUES ($1,'Ada','Lovelace','ada@example.org',now())`,
      [account],
    );
    const { getUser, isAllowed } = await import("../conat/socketio/auth");
    server = await initConatServer({
      getUser,
      isAllowed,
      systemAccountPassword: "secret",
    });
    address = server.address();
    hub = connect({ address, systemAccountPassword: "secret", noCache: true });
    const { setRelayClientForTesting } = await import("./relay");
    setRelayClientForTesting(hub);

    // Pair (the HTTP endpoints are covered elsewhere).
    const r = await import("./requests");
    const { request_id } = await r.createComputerRequest({
      account_id: account,
      name: "m1",
      requested_policy: policy,
    });
    const view = await r.getPairingView(request_id);
    const key = generateSigningKey();
    const transcript = parsePairingTranscript({
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: account,
      policy_hash: policyHash(policy),
      signing_key: key.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "m1", os: "darwin", arch: "arm64", user: "sage" },
    });
    const { transcript_hash } = await r.submitPairing({
      request_id,
      transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, key),
      signing_public_key: key.publicDer,
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

    dir = mkdtempSync(join(tmpdir(), "computer-"));
    DaemonStore.create(join(dir, "state"), {
      certificate: status.certificate,
      ceiling: status.policy,
      directory: status.directory!,
      computer_key: key.fingerprint,
      agent_network_id: network,
    });
    const connection: Connection = {
      dir,
      origin: "https://cocalc.ai",
      computer_id,
      name: "m1",
      key,
      duration: null,
    };
    const { createLoginChallenge } = await import("./sessions");
    stop = new AbortController();
    connected = new Promise((resolve) => {
      connector = runConnector({
        connection,
        io: { log: () => {}, confirm: async () => true },
        signal: stop.signal,
        challenge: () => createLoginChallenge(computer_id),
        openConat: (auth) =>
          connect({ address, noCache: true, reconnection: false, auth } as any),
        onSession: resolve,
      });
    });
    session_id = await connected;
  });

  afterAll(async () => {
    stop?.abort();
    await connector?.catch(() => {});
    hub?.close();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A ticket as the hub issues it (issuance itself is tested elsewhere). */
  async function ticketFor(operation: "exec" | "info", raw: unknown) {
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
    const pop = generateSigningKey();
    const certificate = (
      await db().query(
        "SELECT certificate FROM account_computers WHERE computer_id=$1",
        [computer_id],
      )
    ).rows[0].certificate;
    const ticket = signEnvelope(
      SIGNED_KINDS.ticket,
      parseComputerTicket({
        type: "cocalc-computer-ticket",
        version: 1,
        ticket_id: randomUUID(),
        operation_id: randomUUID(),
        operation,
        request_hash: requestHash(op),
        site: "https://cocalc.ai",
        cluster_id: getConfiguredClusterId(),
        issuer_bay_id: getConfiguredBayId(),
        home_epoch: 0,
        computer_id,
        computer_key: certificate.payload.signing_key,
        account_id: account,
        agent_id: agent,
        agent_network_id: network,
        source_project_id: project,
        attestation,
        computer_epoch: 1,
        policy_epoch: 0,
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
    return {
      ticket,
      proof: signProofOfPossession(
        pop,
        ticket.payload.ticket_id,
        ticket.payload.request_hash,
      ),
      request: op.request,
    };
  }

  it("relays a ticketed exec to the computer and brings back its output", async () => {
    const { relayToComputer } = await import("./relay");
    const result: any = await relayToComputer({
      account_id: account,
      agent_id: agent,
      run_id: run,
      ...(await ticketFor("exec", { command: "echo hello from $((6*7))" })),
    });
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
  });

  it("the relay refuses a ticket for another agent run, and a forged one", async () => {
    const { relayToComputer } = await import("./relay");
    const t = await ticketFor("exec", { command: "true" });
    await expect(
      relayToComputer({
        account_id: account,
        agent_id: agent,
        run_id: randomUUID(),
        ...t,
      }),
    ).rejects.toThrow(/another agent/);
    const forged = signEnvelope(
      SIGNED_KINDS.ticket,
      t.ticket.payload,
      generateSigningKey(),
    );
    await expect(
      relayToComputer({
        account_id: account,
        agent_id: agent,
        run_id: run,
        ...t,
        ticket: forged,
      }),
    ).rejects.toThrow(/not issued here/);
  });

  it("the daemon refuses what the hub would relay without a valid proof", async () => {
    const { relayToComputer } = await import("./relay");
    const t = await ticketFor("exec", { command: "touch /tmp/never" });
    const result: any = await relayToComputer({
      account_id: account,
      agent_id: agent,
      run_id: run,
      ...t,
      proof: signProofOfPossession(
        generateSigningKey(),
        t.ticket.payload.ticket_id,
        t.ticket.payload.request_hash,
      ),
    });
    expect(result.reply).toMatchObject({ ok: false });
    expect(result.reply.refused.join(" ")).toMatch(/proof of possession/);
  });

  it("an account can't publish to the computer or read its replies", async () => {
    const { isAllowed } = await import("../conat/socketio/auth");
    const user = { account_id: account };
    // A positive control: this account principal is otherwise working.
    expect(
      await isAllowed({
        user,
        subject: `hub.account.${account}.api`,
        type: "pub",
      }),
    ).toBe(true);
    const op = computerOpSubject(computer_id, session_id);
    const reply = computerReplySubject(computer_id, session_id, "h", "c");
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

  it("the computer principal: only its own session, and not after revocation", async () => {
    const { isAllowed } = await import("../conat/socketio/auth");
    const row = (
      await db().query(
        "SELECT generation, epoch FROM account_computer_sessions WHERE session_id=$1",
        [session_id],
      )
    ).rows[0];
    const user: any = {
      computer_id,
      computer_account_id: account,
      computer_session_id: session_id,
      computer_generation: Number(row.generation),
      computer_epoch: Number(row.epoch),
      auth_actor: "computer",
      auth_lease_exp_s: Date.now() / 1000 + 600,
    };
    const op = computerOpSubject(computer_id, session_id);
    const reply = computerReplySubject(computer_id, session_id, "h", "c");
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
    // Smuggling an account id never helps.
    expect(
      await isAllowed({
        user: { ...user, account_id: account },
        subject: op,
        type: "sub",
      }),
    ).toBe(false);
    const { revokeComputer } = await import("./computers");
    await revokeComputer({ account_id: account, computer_id });
    expect(await isAllowed({ user, subject: op, type: "sub" })).toBe(false);
    expect(await isAllowed({ user, subject: "", type: "sub" })).toBe(false);
    const { relayToComputer } = await import("./relay");
    await expect(
      relayToComputer({
        account_id: account,
        agent_id: agent,
        run_id: run,
        ...(await ticketFor("exec", { command: "true" })),
      }),
    ).rejects.toThrow(/not connected/);
  });
});
