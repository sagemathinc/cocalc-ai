/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A computer's signed state at its home bay: every change bumps it and
// raises each open session's target; delivery promotes a session to ready
// only on the exact ack of the current version; the one pre-ready capability
// is that ack's exact subject; and revoke, re-pair and account deletion end
// the computer. Real SQL (PGlite): run with COCALC_TEST_USE_PGLITE=1.

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
  canonicalHash,
  generateAgreementKey,
  generateSigningKey,
  policyHash,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "@cocalc/backend/computers/crypto";
import {
  signChallengeRequest,
  signComputerLogin,
} from "@cocalc/backend/computers/login";

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
jest.mock("@cocalc/server/auth/oauth/purge", () => ({
  getOAuthPurgeTargets: async () => [],
  queueOAuthClientPurges: async () => {},
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const tables = [
  "account_computers",
  "account_computer_sessions",
  "account_computer_session_targets",
  "account_computer_project_floors",
  "account_computer_requests",
  "account_computer_challenges",
  "account_computer_relays",
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_personal_controls",
  "agent_networks",
  "accounts",
];

describeDb("a computer's signed state", () => {
  const db = () => getPool();
  let account: string;
  let network: string;
  const requested = (agent_network_id: string) => ({
    version: 1,
    mode: "direct",
    duration: null,
    agent_network_id,
    network: "on",
    gpu: true,
    mounts: [],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  });

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    for (const t of tables.slice().reverse())
      await db().query(`DELETE FROM ${t}`);
    const { resetSigningKeyCacheForTesting } = await import("./signing-keys");
    resetSigningKeyCacheForTesting();
    account = randomUUID();
    network = randomUUID();
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

  afterEach(async () => {
    const { setDeliveryClientForTesting, setDeliveryWaitForTesting } =
      await import("./delivery");
    setDeliveryClientForTesting(undefined);
    setDeliveryWaitForTesting(undefined);
  });

  async function pairedComputer(name = "server") {
    const r = await import("./requests");
    const policy = parseComputerPolicy(requested(network));
    const { request_id } = await r.createComputerRequest({
      account_id: account,
      name,
      requested_policy: requested(network),
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
      machine: { hostname: "m1", os: "linux", arch: "x64", user: "sage" },
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
    const { computer_id } = await r.approveComputerRequest({
      account_id: account,
      request_id,
      transcript_hash,
      agent_network_generation: generation,
    });
    const status = await r.getPairingStatus({ request_id, transcript_hash });
    return { computer_id, key, certificate: status.certificate!, policy };
  }

  type Paired = Awaited<ReturnType<typeof pairedComputer>>;

  async function login(c: Paired) {
    const { createLoginChallenge, loginComputer } = await import("./sessions");
    const challenge: any = await createLoginChallenge(
      signChallengeRequest({ certificate: c.certificate, key: c.key }),
    );
    return await loginComputer(
      signComputerLogin({ challenge, certificate: c.certificate, key: c.key }),
    );
  }

  const target = async (session_id: string) =>
    (
      await db().query(
        "SELECT * FROM account_computer_session_targets WHERE session_id=$1",
        [session_id],
      )
    ).rows[0];
  const version = async (computer_id: string) =>
    `${
      (
        await db().query(
          "SELECT state_version FROM account_computers WHERE computer_id=$1",
          [computer_id],
        )
      ).rows[0].state_version
    }`;
  const readyVersion = async (session_id: string) =>
    (
      await db().query(
        "SELECT ready_version FROM account_computer_sessions WHERE session_id=$1",
        [session_id],
      )
    ).rows[0].ready_version;

  /**
   * A conat client that answers each push the way `respond` says (undefined:
   * no answer), and records every publish. `count` is the publish's
   * subscriber count.
   */
  function fakeClient(
    respond: (op: any) => unknown,
    { count = 1 }: { count?: number } = {},
  ) {
    const published: any[] = [];
    const inboxes = new Map<string, (m: any) => void>();
    const client = {
      subscribe: async (subject: string) => {
        const queue: any[] = [];
        let wake: (() => void) | undefined;
        let closed = false;
        inboxes.set(subject, (m) => {
          queue.push(m);
          wake?.();
        });
        return {
          close() {
            closed = true;
            wake?.();
          },
          async *[Symbol.asyncIterator]() {
            while (!closed) {
              if (queue.length > 0) {
                yield queue.shift();
                continue;
              }
              await new Promise<void>((r) => (wake = r));
            }
          },
        };
      },
      publish: async (subject: string, op: any) => {
        published.push({ subject, op });
        const reply = respond(op);
        if (reply !== undefined) {
          inboxes.get(op.reply_subject)?.({
            data: { v: 1, correlation: op.correlation, reply },
          });
        }
        return { count };
      },
    };
    return { client, published };
  }

  /** The ack a daemon gives after applying the snapshot it was sent. */
  const honest = (op: any) => ({
    ok: true,
    state_version: op.push.state.payload.state_version,
    envelope_hash: canonicalHash(op.push.state),
  });

  it("a login is not ready until its daemon acks the current state; then it is", async () => {
    const { deliverDueStates, setDeliveryClientForTesting } =
      await import("./delivery");
    const { sessionIsCurrent } = await import("./sessions");
    const c = await pairedComputer();
    const s = await login(c);
    expect(await target(s.session_id)).toMatchObject({
      state_version: "0",
      generation: 1,
    });
    expect(await readyVersion(s.session_id)).toBeNull();
    expect(await sessionIsCurrent(s, Date.now(), { requireReady: true })).toBe(
      false,
    );
    const { client, published } = fakeClient(honest);
    setDeliveryClientForTesting(client as any);
    expect(await deliverDueStates()).toBe(1);
    // Exactly one push, on the session's op subject, signed with the
    // certificate's own key, to an exact reply subject of this session.
    expect(published).toHaveLength(1);
    const { op, subject } = published[0];
    expect(subject).toBe(`computer.${c.computer_id}.${s.session_id}.op.v1`);
    expect(op.message).toBeUndefined();
    expect(op.reply_subject).toBe(
      `hub.computer.${c.computer_id}.reply.v1.${s.session_id}.${(await import("./relay")).HUB_PROCESS}.${op.correlation}`,
    );
    const { trustedSigningKeys } = await import("./signing-keys");
    const keys = await trustedSigningKeys();
    expect(op.push.state.kid).toBe(c.certificate.kid);
    expect(
      verifyEnvelope(SIGNED_KINDS.state, op.push.state, (kid) => keys.get(kid)),
    ).toBe(true);
    expect(op.push.state.payload).toMatchObject({
      computer_id: c.computer_id,
      state_version: "0",
      computer_epoch: 1,
      home_epoch: 0,
      policy_epoch: 0,
      ended: null,
      project_floors: {},
    });
    expect(op.push.state.payload.policy).toEqual(c.policy);
    expect(await target(s.session_id)).toBeUndefined();
    expect(`${await readyVersion(s.session_id)}`).toBe("0");
    expect(await sessionIsCurrent(s, Date.now(), { requireReady: true })).toBe(
      true,
    );
    // Nothing more to do.
    expect(await deliverDueStates()).toBe(0);
    expect(published).toHaveLength(1);
  });

  it("every change raises the target of every open session, whatever its epoch, and a stale attempt can't finalize", async () => {
    const { finalize } = await import("./delivery");
    const { bumpComputersForNetwork, setEffectivePolicy } =
      await import("./computers");
    const c = await pairedComputer();
    const s1 = await login(c);
    const s2 = await login(c);
    // A claimed attempt for version 0.
    await db().query(
      `UPDATE account_computer_session_targets
          SET attempt_token='old', claimed_by_hub='h', reply_subject='x',
              lease_until=now() + interval '30 seconds'
        WHERE session_id=$1`,
      [s1.session_id],
    );
    await bumpComputersForNetwork(db(), account, network);
    expect(await version(c.computer_id)).toBe("1");
    for (const s of [s1, s2]) {
      expect(await target(s.session_id)).toMatchObject({
        state_version: "1",
        attempt_token: null,
        claimed_by_hub: null,
        lease_until: null,
      });
    }
    // The old attempt's ack (of version 0) finalizes nothing...
    expect(await finalize({ ...s1, attempt_token: "old" }, "0")).toBe(false);
    // ...nor does an ack of the current version from a stale attempt.
    expect(await finalize({ ...s1, attempt_token: "old" }, "1")).toBe(false);
    expect(await readyVersion(s1.session_id)).toBeNull();
    // A policy change raises them again, past an attempt claimed at 1.
    await db().query(
      "UPDATE account_computer_session_targets SET attempt_token='t1' WHERE session_id=$1",
      [s2.session_id],
    );
    await setEffectivePolicy({
      account_id: account,
      computer_id: c.computer_id,
      policy: {
        ...c.policy,
        duration: { initial_seconds: 3600, max_seconds: 7200 },
      },
    });
    expect(await version(c.computer_id)).toBe("2");
    expect(await finalize({ ...s2, attempt_token: "t1" }, "1")).toBe(false);
    expect((await target(s2.session_id)).state_version).toBe("2");
    // A closed session is not raised (its target is dropped).
    const { closeComputerSession } = await import("./sessions");
    await closeComputerSession(s1);
    const { deliverDueStates, setDeliveryClientForTesting } =
      await import("./delivery");
    const { client } = fakeClient(honest);
    setDeliveryClientForTesting(client as any);
    expect(await deliverDueStates()).toBe(1);
    expect(await target(s1.session_id)).toBeUndefined();
    expect(await readyVersion(s1.session_id)).toBeNull();
    expect(`${await readyVersion(s2.session_id)}`).toBe("2");
  });

  it("only the exact ack finalizes: ok:false, another version or hash, or none, retry with backoff", async () => {
    const {
      deliverDueStates,
      setDeliveryClientForTesting,
      setDeliveryWaitForTesting,
    } = await import("./delivery");
    const c = await pairedComputer();
    const s = await login(c);
    setDeliveryWaitForTesting(200);
    const answers: [string, (op: any) => unknown][] = [
      [
        "refused",
        () => ({ ok: false, error: "the state is not signed by the home bay" }),
      ],
      ["another version", (op) => ({ ...honest(op), state_version: "7" })],
      ["another hash", (op) => ({ ...honest(op), envelope_hash: "sha256:x" })],
      ["a number", (op) => ({ ...honest(op), state_version: 0 })],
      ["nothing", () => undefined],
    ];
    for (const [what, respond] of answers) {
      const { client, published } = fakeClient(respond);
      setDeliveryClientForTesting(client as any);
      expect([what, await deliverDueStates()]).toEqual([what, 0]);
      expect(published).toHaveLength(1);
      const t = await target(s.session_id);
      expect(t.attempt_token).toBeNull();
      expect(t.claimed_by_hub).toBeNull();
      expect(new Date(t.lease_until).valueOf()).toBeGreaterThan(Date.now());
      expect(t.last_error).toBeTruthy();
      expect(await readyVersion(s.session_id)).toBeNull();
      // Due again now.
      await db().query(
        "UPDATE account_computer_session_targets SET lease_until=NULL WHERE session_id=$1",
        [s.session_id],
      );
    }
    expect((await target(s.session_id)).last_error).toBe("no acknowledgement");
    // Nobody subscribed yet (the daemon is still subscribing): soon again.
    const { client } = fakeClient(honest, { count: 0 });
    setDeliveryClientForTesting(client as any);
    expect(await deliverDueStates()).toBe(0);
    const t = await target(s.session_id);
    expect(t.last_error).toBe("no subscriber yet");
    expect(new Date(t.lease_until).valueOf()).toBeLessThan(Date.now() + 1000);
  });

  it("the one thing a session may publish before it is ready: the ack, on the claimed attempt's exact subject", async () => {
    const { isStateReceipt } = await import("./sessions");
    const c = await pairedComputer();
    const s = await login(c);
    const subject = (token: string) =>
      `hub.computer.${c.computer_id}.reply.v1.${s.session_id}.hub.${token}`;
    // Unclaimed: nothing.
    expect(await isStateReceipt(s, subject("t1"))).toBe(false);
    await db().query(
      `UPDATE account_computer_session_targets
          SET attempt_token='t1', claimed_by_hub='hub', reply_subject=$2,
              lease_until=now() + interval '30 seconds'
        WHERE session_id=$1`,
      [s.session_id, subject("t1")],
    );
    expect(await isStateReceipt(s, subject("t1"))).toBe(true);
    expect(await isStateReceipt(s, subject("t2"))).toBe(false);
    expect(
      await isStateReceipt(
        { ...s, generation: s.generation + 1 },
        subject("t1"),
      ),
    ).toBe(false);
    expect(
      await isStateReceipt({ ...s, computer_id: randomUUID() }, subject("t1")),
    ).toBe(false);
    // Lease over: nothing.
    await db().query(
      "UPDATE account_computer_session_targets SET lease_until=now() - interval '1 second' WHERE session_id=$1",
      [s.session_id],
    );
    expect(await isStateReceipt(s, subject("t1"))).toBe(false);
    // Closed session: nothing.
    await db().query(
      "UPDATE account_computer_session_targets SET lease_until=now() + interval '30 seconds' WHERE session_id=$1",
      [s.session_id],
    );
    const { closeComputerSession } = await import("./sessions");
    await closeComputerSession(s);
    expect(await isStateReceipt(s, subject("t1"))).toBe(false);
  });

  it("revoke, re-pair and account deletion end the computer, each for good, with its reason", async () => {
    const { computerStateSnapshot } = await import("./state");
    const { revokeComputer, endComputersForAccountDeletion } =
      await import("./computers");
    const a = await pairedComputer("a");
    const s = await login(a);
    await revokeComputer({ account_id: account, computer_id: a.computer_id });
    const v = await version(a.computer_id);
    expect(
      (await computerStateSnapshot(a.computer_id))!.envelope.payload.ended,
    ).toEqual({ reason: "revoked" });
    // The open session owes the ended state.
    expect((await target(s.session_id)).state_version).toBe(v);
    // Revoking again changes nothing.
    await revokeComputer({ account_id: account, computer_id: a.computer_id });
    expect(await version(a.computer_id)).toBe(v);

    // A computer past its time, replaced by a new pairing with its name.
    const b = await pairedComputer("b");
    await db().query(
      "UPDATE account_computers SET deadline=now() - interval '1 minute' WHERE computer_id=$1",
      [b.computer_id],
    );
    await pairedComputer("b");
    expect(
      (await computerStateSnapshot(b.computer_id))!.envelope.payload.ended,
    ).toEqual({ reason: "replaced" });

    const d = await pairedComputer("d");
    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await endComputersForAccountDeletion(client, account);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const ended = (await computerStateSnapshot(d.computer_id))!.envelope
      .payload;
    expect(ended.ended).toEqual({ reason: "deleted" });
    // The first reason stays: a revoked computer is not "deleted" later.
    expect(
      (await computerStateSnapshot(a.computer_id))!.envelope.payload.ended,
    ).toEqual({ reason: "revoked" });
  });

  it("deleting the account ends its computers in the deletion's own transaction", async () => {
    const { markAccountDeleted } = await import("../accounts/delete");
    const { computerStateSnapshot } = await import("./state");
    const c = await pairedComputer();
    await markAccountDeleted(account);
    expect(
      (
        await db().query("SELECT deleted FROM accounts WHERE account_id=$1", [
          account,
        ])
      ).rows[0].deleted,
    ).toBe(true);
    expect(
      (await computerStateSnapshot(c.computer_id))!.envelope.payload.ended,
    ).toEqual({ reason: "deleted" });
    // And when it asks to log in, it is told so, though the account is gone.
    const { createLoginChallenge } = await import("./sessions");
    const answer: any = await createLoginChallenge(
      signChallengeRequest({ certificate: c.certificate, key: c.key }),
    );
    expect(answer.ended.payload.ended).toEqual({ reason: "deleted" });
  });

  it("the snapshot carries the project floors, and is signed by the certificate's key after the bay's key rotates", async () => {
    const { computerStateSnapshot } = await import("./state");
    const c = await pairedComputer();
    const p = randomUUID();
    await db().query(
      `INSERT INTO account_computer_project_floors
         (computer_id, project_id, account_id, privacy_epoch)
       VALUES ($1,$2,$3,7)`,
      [c.computer_id, p, account],
    );
    // Rotate: the certificate's key is retired (still valid), a new one signs.
    await db().query(
      "UPDATE bay_computer_signing_keys SET created_at=now() - interval '301 days'",
    );
    const { getBaySigningKey, resetSigningKeyCacheForTesting } =
      await import("./signing-keys");
    resetSigningKeyCacheForTesting();
    const fresh = await getBaySigningKey();
    expect(fresh.fingerprint).not.toBe(c.certificate.kid);
    const snapshot = (await computerStateSnapshot(c.computer_id))!;
    expect(snapshot.envelope.kid).toBe(c.certificate.kid);
    expect(snapshot.envelope.payload.project_floors).toEqual({ [p]: 7 });
    // Once that key is past its not_after (so is the certificate), there is
    // nothing to sign with: no snapshot, rather than one the daemon can't
    // verify.
    await db().query(
      "UPDATE bay_computer_signing_keys SET not_after=now() - interval '1 second' WHERE kid=$1",
      [c.certificate.kid],
    );
    expect(await computerStateSnapshot(c.computer_id)).toBeUndefined();
  });
});
