/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A paired computer logs in to conat: challenge, signed login, session
// slots, and every way a session stops being current. Real SQL (PGlite):
// run with COCALC_TEST_USE_PGLITE=1.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  parsePairingTranscript,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import {
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
} from "@cocalc/backend/computers/crypto";
import { signComputerLogin } from "@cocalc/backend/computers/login";
import {
  computerOpSubject,
  computerReplySubject,
  computerSubjectAllowed,
} from "@cocalc/conat/computers/subjects";

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

describeDb("computer sessions", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();
  const requested = {
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
  };
  const resolved = parseComputerPolicy(requested);

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    for (const t of tables.slice().reverse())
      await db().query(`DELETE FROM ${t}`);
    const { resetSigningKeyCacheForTesting } = await import("./signing-keys");
    resetSigningKeyCacheForTesting();
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
  });

  /** A paired, approved computer: its key and certificate. */
  async function pairedComputer() {
    const { createComputerRequest, getPairingView, submitPairing } =
      await import("./requests");
    const { approveComputerRequest, getPairingStatus } =
      await import("./requests");
    const { request_id } = await createComputerRequest({
      account_id: account,
      name: "server",
      requested_policy: requested,
    });
    const view = await getPairingView(request_id);
    const key = generateSigningKey();
    const transcript = parsePairingTranscript({
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: account,
      policy_hash: policyHash(resolved),
      signing_key: key.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "m1", os: "darwin", arch: "arm64", user: "sage" },
    });
    const { transcript_hash } = await submitPairing({
      request_id,
      transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, key),
      signing_public_key: key.publicDer,
      resolved_policy: resolved,
    });
    const generation = (
      await db().query(
        "SELECT generation FROM agent_networks WHERE agent_network_id=$1",
        [network],
      )
    ).rows[0].generation;
    const { computer_id } = await approveComputerRequest({
      account_id: account,
      request_id,
      transcript_hash,
      agent_network_generation: generation,
    });
    const status = await getPairingStatus({ request_id, transcript_hash });
    expect(status.directory?.length).toBeGreaterThan(0);
    expect(status.policy).toEqual(resolved);
    return { computer_id, key, certificate: status.certificate! };
  }

  async function login(c: Awaited<ReturnType<typeof pairedComputer>>) {
    const { createLoginChallenge, loginComputer } = await import("./sessions");
    const challenge = await createLoginChallenge(c.computer_id);
    const signed = signComputerLogin({
      challenge,
      certificate: c.certificate,
      key: c.key,
    });
    return { signed, session: await loginComputer(signed) };
  }

  it("logs in once per challenge, with a lease, and the session is current", async () => {
    const { loginComputer, sessionIsCurrent, currentSession } =
      await import("./sessions");
    const c = await pairedComputer();
    const { signed, session } = await login(c);
    expect(session).toMatchObject({
      computer_id: c.computer_id,
      account_id: account,
      slot: 1,
      generation: 1,
      epoch: 1,
    });
    expect(session.lease_until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(await sessionIsCurrent(session)).toBe(true);
    expect((await currentSession(c.computer_id))?.session_id).toBe(
      session.session_id,
    );
    // The same signed login again: its challenge is consumed.
    await expect(loginComputer(signed)).rejects.toThrow(/challenge/);
  });

  it("refuses a login by another key, for another computer, or tampered", async () => {
    const { createLoginChallenge, loginComputer } = await import("./sessions");
    const c = await pairedComputer();
    const challenge = await createLoginChallenge(c.computer_id);
    const stranger = generateSigningKey();
    // Another key can't even claim the certificate.
    expect(() =>
      signComputerLogin({
        challenge,
        certificate: c.certificate,
        key: stranger,
      }),
    ).toThrow(/not the certificate's key/);
    // Signed by another key, naming the right one.
    const good = signComputerLogin({
      challenge,
      certificate: c.certificate,
      key: c.key,
    });
    const forged = signEnvelope(SIGNED_KINDS.login, good.payload, stranger);
    await expect(loginComputer(forged)).rejects.toThrow(/another key/);
    const relabeled = { ...forged, kid: c.key.fingerprint };
    await expect(loginComputer(relabeled)).rejects.toThrow(/signature/);
    // A changed payload under the real signature.
    await expect(
      loginComputer({
        ...good,
        payload: { ...good.payload, nonce: randomNonce() },
      }),
    ).rejects.toThrow(/signature/);
    // A wrong nonce, properly signed.
    const wrongNonce = signEnvelope(
      SIGNED_KINDS.login,
      { ...good.payload, nonce: randomNonce() },
      c.key,
    );
    await expect(loginComputer(wrongNonce)).rejects.toThrow(/challenge/);
    // The real one still works (nothing above consumed it).
    expect((await loginComputer(good)).slot).toBe(1);
  });

  it("a challenge for one computer can't log in another", async () => {
    const { createLoginChallenge, loginComputer } = await import("./sessions");
    const a = await pairedComputer();
    await db().query(
      `UPDATE account_computers SET name='old' WHERE computer_id=$1`,
      [a.computer_id],
    );
    const b = await pairedComputer();
    const challenge = await createLoginChallenge(a.computer_id);
    const signed = signComputerLogin({
      challenge,
      certificate: b.certificate,
      key: b.key,
    });
    await expect(loginComputer(signed)).rejects.toThrow(/challenge/);
  });

  it("two slots; a third login reclaims the oldest session", async () => {
    const { sessionIsCurrent } = await import("./sessions");
    const c = await pairedComputer();
    const one = (await login(c)).session;
    const two = (await login(c)).session;
    expect([one.slot, two.slot]).toEqual([1, 2]);
    const three = (await login(c)).session;
    expect(three.slot).toBe(1);
    expect(await sessionIsCurrent(one)).toBe(false);
    expect(await sessionIsCurrent(two)).toBe(true);
    expect(await sessionIsCurrent(three)).toBe(true);
  });

  it("revoking, an epoch bump, a closed session or an expired lease end it", async () => {
    const { sessionIsCurrent, closeComputerSession, createLoginChallenge } =
      await import("./sessions");
    const { revokeComputer, bumpComputersForAccount } =
      await import("./computers");
    const c = await pairedComputer();
    const s1 = (await login(c)).session;
    await bumpComputersForAccount(db(), account);
    expect(await sessionIsCurrent(s1)).toBe(false);
    const s2 = (await login(c)).session;
    expect(s2.epoch).toBe(2);
    expect(await sessionIsCurrent(s2)).toBe(true);
    expect(await sessionIsCurrent(s2, s2.lease_until)).toBe(false);
    await closeComputerSession(s2);
    expect(await sessionIsCurrent(s2)).toBe(false);
    const s3 = (await login(c)).session;
    await revokeComputer({ account_id: account, computer_id: c.computer_id });
    expect(await sessionIsCurrent(s3)).toBe(false);
    // And a revoked computer gets no challenge.
    await expect(createLoginChallenge(c.computer_id)).rejects.toThrow(
      /no such computer/,
    );
  });

  it("caps open challenges per computer", async () => {
    const { createLoginChallenge } = await import("./sessions");
    const c = await pairedComputer();
    for (let i = 0; i < 5; i++) await createLoginChallenge(c.computer_id);
    await expect(createLoginChallenge(c.computer_id)).rejects.toThrow(
      /too many/,
    );
    await expect(createLoginChallenge(randomUUID())).rejects.toThrow(
      /no such computer/,
    );
  });

  it("subject policy: only the session's exact op subject and its own reply subjects", () => {
    const computer = randomUUID();
    const session = randomUUID();
    const other = randomUUID();
    const op = computerOpSubject(computer, session);
    const reply = computerReplySubject(computer, session, "hub1", "corr");
    const allow = (subject: string, type: "sub" | "pub") =>
      computerSubjectAllowed(computer, session, subject, type);
    expect(allow(op, "sub")).toBe(true);
    expect(allow(op, "pub")).toBe(false);
    expect(allow(reply, "pub")).toBe(true);
    expect(allow(reply, "sub")).toBe(false);
    for (const subject of [
      computerOpSubject(computer, other),
      computerOpSubject(other, session),
      `computer.${computer}.${session}.>`,
      `computer.${computer}.*.op.v1`,
      `computer.>`,
      `>`,
      `${op}.x`,
    ]) {
      expect(allow(subject, "sub")).toBe(false);
    }
    for (const subject of [
      computerReplySubject(computer, other, "hub1", "corr"),
      computerReplySubject(other, session, "hub1", "corr"),
      `${reply}.more`,
      reply.replace("corr", "*"),
      reply.replace("corr", ">"),
      `hub.computer.${computer}.reply.v1.${session}.hub1`,
      `hub.computer.${computer}.reply.v1.${session}`,
      `hub.computer.${computer}.api.v1.${session}`,
      `_INBOX.anything`,
      `hub.account.${computer}.api`,
      `project.${randomUUID()}.x`,
    ]) {
      expect(allow(subject, "pub")).toBe(false);
    }
  });
});
