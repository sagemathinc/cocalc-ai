/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only; no network.

import { generateKeyPairSync, sign } from "node:crypto";
import {
  authenticateFederatedBroker,
  isFederatedBrokerAllowed,
  isReservedForFederatedBroker,
  looksLikeGoogleIdToken,
  signerRecordFromSetting,
} from "./broker-auth";

const SIGNER = "fake-broker@example-project-1.iam.gserviceaccount.com";
const ID = "109876543210987654321";
const OTHER = "109876543210987654322";
const SETTING = `${SIGNER} ${ID}`;
const CLUSTER = "cluster-1";
const NOW_S = 1_800_000_000;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const certs = async () =>
  new Map([["kid-1", publicKey.export({ format: "jwk" })]]);

function idToken(payload: Record<string, unknown> = {}) {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "kid-1", typ: "JWT" });
  const body = enc({
    iss: "https://accounts.google.com",
    aud: CLUSTER,
    sub: ID,
    iat: NOW_S - 5,
    exp: NOW_S + 3000,
    ...payload,
  });
  const sig = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    privateKey,
  ).toString("base64url");
  return `${head}.${body}.${sig}`;
}

describe("authenticateFederatedBroker", () => {
  const auth = (token: string, signerSetting: unknown = SETTING) =>
    authenticateFederatedBroker({
      token,
      clusterId: CLUSTER,
      signerSetting,
      certs,
      nowS: NOW_S,
    });

  it("returns the broker principal, its lease ending at the token's expiry", async () => {
    await expect(auth(idToken())).resolves.toEqual({
      hub_id: "federated-broker",
      federated_broker_signer_id: ID,
      auth_lease_exp_s: NOW_S + 3000,
    });
  });

  it("refuses an expired token, the wrong audience and another signer", async () => {
    await expect(auth(idToken({ exp: NOW_S - 61 }))).rejects.toThrow(
      "id_token_expired",
    );
    await expect(auth(idToken({ aud: "cluster-2" }))).rejects.toThrow(
      "id_token_audience",
    );
    await expect(auth(idToken({ sub: OTHER }))).rejects.toThrow(
      "identity_mismatch",
    );
  });

  it("fails closed with no or a malformed signer record", async () => {
    for (const setting of [null, "", "x 1", `${SIGNER} 0123456`]) {
      await expect(auth(idToken(), setting)).rejects.toThrow(
        "broker_not_configured",
      );
    }
  });

  it("follows a signer rotation: a token for the old signer is refused", async () => {
    await expect(auth(idToken(), `${SIGNER} ${OTHER}`)).rejects.toThrow(
      "identity_mismatch",
    );
  });

  it("recognizes a Google ID token by its issuer only", () => {
    expect(looksLikeGoogleIdToken(idToken())).toBe(true);
    expect(
      looksLikeGoogleIdToken("00000000-0000-4000-8000-000000000001.secret"),
    ).toBe(false);
    expect(
      looksLikeGoogleIdToken(idToken({ iss: "https://evil.example" })),
    ).toBe(false);
  });

  it("parses the signer setting", () => {
    expect(signerRecordFromSetting(SETTING)).toEqual({
      email: SIGNER,
      uniqueId: ID,
    });
    expect(signerRecordFromSetting("")).toBeUndefined();
  });
});

describe("isFederatedBrokerAllowed", () => {
  const allowed = (
    subject: string,
    type: "pub" | "sub",
    signerId: unknown = ID,
    currentSignerId: string | undefined = ID,
  ) =>
    isFederatedBrokerAllowed({
      signerId,
      currentSignerId,
      clusterId: CLUSTER,
      subject,
      type,
    });

  it.each([
    ["pub", "_INBOX.abc.123"],
    ["pub", "bay.bay-a.rpc.federated-broker.v1"],
    ["pub", "broker.cluster-1.heartbeat.v1"],
    ["sub", "broker.cluster-1.rpc.mint.v1"],
    ["sub", `_INBOX.broker-${ID}.xyz`],
    ["sub", `_INBOX.broker-${ID}.xyz.>`],
  ] as const)("allows %s %s", (type, subject) => {
    expect(allowed(subject, type)).toBe(true);
  });

  it.each([
    ["pub", "_INBOX.>"],
    ["pub", "_INBOX.*"],
    ["pub", "bay.bay-a.rpc.federated-connector.v1"],
    ["pub", "bay.bay-a.rpc.agent-connector.v1"],
    ["pub", "bay.bay-a.rpc.federated-gate-replica.v1"],
    ["pub", "bay.*.rpc.federated-broker.v1"],
    ["pub", "bay.bay-a.rpc.federated-broker.v1.x"],
    ["pub", "hub.account.x.api"],
    ["pub", "broker.cluster-1.rpc.mint.v1"],
    ["pub", "broker.cluster-2.heartbeat.v1"],
    ["pub", "global.directory.rpc.resolve-project-bay"],
    ["sub", "_INBOX.>"],
    ["sub", "_INBOX.abc.123"],
    ["sub", `_INBOX.broker-${OTHER}.xyz`],
    ["sub", `_INBOX.broker-${ID}`],
    ["sub", "broker.cluster-2.rpc.mint.v1"],
    ["sub", "broker.>"],
    ["sub", "bay.bay-a.rpc.federated-broker.v1"],
    ["sub", "hub.>"],
    ["sub", ">"],
  ] as const)("refuses %s %s", (type, subject) => {
    expect(allowed(subject, type)).toBe(false);
  });

  it("refuses everything once the signer record names another identity, or none", () => {
    expect(allowed("broker.cluster-1.rpc.mint.v1", "sub", ID, OTHER)).toBe(
      false,
    );
    expect(allowed("_INBOX.abc", "pub", ID, null)).toBe(false);
    expect(allowed("_INBOX.abc", "pub", Number(ID))).toBe(false);
  });
});

describe("isReservedForFederatedBroker", () => {
  it.each([
    ["pub", "bay.bay-a.rpc.federated-broker.v1", true],
    ["pub", "bay.*.rpc.federated-broker.v1", true],
    ["pub", "bay.bay-a.rpc.>", true],
    ["pub", `broker.${CLUSTER}.heartbeat.v1`, true],
    ["sub", `broker.${CLUSTER}.rpc.mint.v1`, true],
    ["sub", "broker.*.rpc.*.v1", true],
    ["sub", "broker.>", true],
    ["sub", ">", true],
    ["pub", `broker.${CLUSTER}.rpc.mint.v1`, false],
    ["pub", "bay.bay-a.rpc.federated-connector.v1", false],
    ["pub", "bay.bay-a.rpc.federated-broker.v1.x", false],
    ["sub", `broker.${CLUSTER}.heartbeat.v1`, false],
    ["sub", "bay.bay-a.rpc.federated-broker.v1", false],
    ["sub", `broker.${CLUSTER}.rpc.mint`, false],
    ["sub", "broker.other-cluster.rpc.mint.v1", false],
  ] as const)("%s %s → %s", (type, subject, reserved) => {
    expect(
      isReservedForFederatedBroker({ clusterId: CLUSTER, subject, type }),
    ).toBe(reserved);
  });
});
