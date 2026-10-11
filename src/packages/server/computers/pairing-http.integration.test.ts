/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The machine's side of pairing, through the unauthenticated endpoints,
// against real SQL (PGlite). Run with COCALC_TEST_USE_PGLITE=1.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { parseComputerPolicy } from "@cocalc/util/computers/policy";
import {
  parsePairingTranscript,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import type { PairingView } from "@cocalc/util/computers/api";
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
  "cluster_computer_signing_keys",
  "bay_computer_signing_keys",
  "agent_networks",
  "accounts",
];

describeDb("computer pairing endpoints", () => {
  const db = () => getPool();
  const account = randomUUID();
  const network = randomUUID();
  const requested = {
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
  };
  const resolved = parseComputerPolicy(requested);

  beforeAll(async () => {
    await syncSchema(Object.fromEntries(tables.map((t) => [t, SCHEMA[t]])));
  });

  beforeEach(async () => {
    for (const t of tables) await db().query(`DELETE FROM ${t}`);
    const { resetSigningKeyCacheForTesting } = await import("./signing-keys");
    resetSigningKeyCacheForTesting();
    const { resetPairingRateLimitForTesting } = await import("./pairing-http");
    resetPairingRateLimitForTesting();
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

  async function newRequest() {
    const { createComputerRequest } = await import("./requests");
    return await createComputerRequest({
      account_id: account,
      name: "server",
      requested_policy: requested,
    });
  }

  function unwrap<T>(result: T | { error: string }): T {
    if (result != null && typeof result === "object" && "error" in result) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    return result as T;
  }

  async function claim(request_id: string, address = "198.51.100.7") {
    const { pairingSubmit, pairingView } = await import("./pairing-http");
    const view = unwrap(
      await pairingView({ request_id }, address),
    ) as PairingView;
    const signing = generateSigningKey();
    const transcript = parsePairingTranscript({
      type: "cocalc-computer-pairing",
      version: 1,
      site: view.site,
      cluster_id: view.cluster_id,
      request_id,
      account_id: view.account_id,
      policy_hash: policyHash(resolved),
      signing_key: signing.fingerprint,
      agreement_key: generateAgreementKey().fingerprint,
      client_nonce: randomNonce(),
      server_nonce: view.server_nonce,
      machine: { hostname: "bench-1", os: "linux", arch: "x64", user: "w" },
    });
    const submitted = await pairingSubmit(
      {
        request_id,
        transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, signing),
        signing_public_key: signing.publicDer,
        resolved_policy: resolved,
      },
      address,
    );
    return { view, submitted, signing };
  }

  it("view, claim, poll, approve, collect the certificate, then see revocation", async () => {
    const { pairingStatus } = await import("./pairing-http");
    const { approveComputerRequest } = await import("./requests");
    const { revokeComputer } = await import("./computers");
    const { request_id } = await newRequest();
    const { view, submitted, signing } = await claim(request_id);
    // The machine shows whose account this is, with the email partly masked.
    expect(view.account_label).toBe("Ada Lovelace <a***@e***.org>");
    expect(view.requested_policy.mode).toBe("direct");
    const { transcript_hash, pairing_phrase } = unwrap(submitted);

    expect(
      unwrap(await pairingStatus({ request_id, transcript_hash }, "x")),
    ).toEqual({
      request_id,
      state: "paired",
      pairing_phrase,
      expires_at: expect.any(Number),
    });

    const { computer_id } = await approveComputerRequest({
      account_id: account,
      request_id,
      transcript_hash,
    });
    const approved = unwrap(
      await pairingStatus({ request_id, transcript_hash }, "x"),
    );
    expect(approved).toMatchObject({
      state: "approved",
      computer_id,
      name: "server",
    });
    expect(approved.certificate!.payload.signing_key).toBe(signing.fingerprint);
    const { trustedSigningKeys } = await import("./signing-keys");
    const keys = await trustedSigningKeys();
    expect(
      verifyEnvelope(SIGNED_KINDS.certificate, approved.certificate!, (kid) =>
        keys.get(kid),
      ),
    ).toBe(true);

    await revokeComputer({ account_id: account, computer_id });
    const revoked = unwrap(
      await pairingStatus({ request_id, transcript_hash }, "x"),
    );
    expect(revoked.state).toBe("revoked");
    expect(revoked.certificate).toBeUndefined();
  });

  it("answers nobody without the transcript hash, the same as for no request", async () => {
    const { pairingStatus } = await import("./pairing-http");
    const { request_id } = await newRequest();
    // Before anyone claimed it, and with a wrong hash after: identical.
    const before = await pairingStatus(
      { request_id, transcript_hash: "sha256:" + "0".repeat(64) },
      "x",
    );
    await claim(request_id);
    const wrong = await pairingStatus(
      { request_id, transcript_hash: "sha256:" + "0".repeat(64) },
      "x",
    );
    const missing = await pairingStatus({ request_id }, "x");
    const unknown = await pairingStatus(
      { request_id: "R-0000000000", transcript_hash: "x" },
      "x",
    );
    for (const answer of [before, wrong, missing, unknown]) {
      expect(answer).toEqual({ error: "no such computer pairing" });
    }
  });

  it("reports request and protocol errors, and nothing about internal ones", async () => {
    const { pairingSubmit, pairingView } = await import("./pairing-http");
    expect(await pairingView({ request_id: "nope" }, "x")).toEqual({
      error: "malformed computer request id",
    });
    expect(await pairingView({}, "x")).toEqual({
      error: "malformed computer request id",
    });
    const { request_id } = await newRequest();
    const bad = await pairingSubmit(
      { request_id, transcript: "not a transcript", signing_public_key: "" },
      "x",
    );
    expect((bad as { error: string }).error).toMatch(/transcript/);

    const pool = getPool();
    const query = jest
      .spyOn(pool, "query")
      .mockRejectedValueOnce(new Error("connection to 10.0.0.5 refused"));
    try {
      expect(await pairingView({ request_id }, "x")).toEqual({
        error: "pairing failed; try again",
      });
    } finally {
      query.mockRestore();
    }
  });

  it("rate-limits each address", async () => {
    const {
      pairingView,
      pairingSubmit,
      PAIRING_READS_PER_MINUTE,
      PAIRING_SUBMITS_PER_MINUTE,
    } = await import("./pairing-http");
    const { request_id } = await newRequest();
    const now = Date.now();
    for (let i = 0; i < PAIRING_READS_PER_MINUTE; i++) {
      unwrap(await pairingView({ request_id }, "203.0.113.1", now));
    }
    expect(await pairingView({ request_id }, "203.0.113.1", now)).toEqual({
      error: expect.stringMatching(/too many pairing attempts/),
    });
    // Another address, and the same one a minute later, are fine.
    unwrap(await pairingView({ request_id }, "203.0.113.2", now));
    unwrap(await pairingView({ request_id }, "203.0.113.1", now + 60_000));

    for (let i = 0; i < PAIRING_SUBMITS_PER_MINUTE; i++) {
      await pairingSubmit({ request_id }, "203.0.113.3", now);
    }
    expect(await pairingSubmit({ request_id }, "203.0.113.3", now)).toEqual({
      error: expect.stringMatching(/too many pairing attempts/),
    });
  });
});
