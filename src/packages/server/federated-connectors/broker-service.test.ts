/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import type { MintRequest, MintResult } from "./broker";
import {
  BROKER_PUBLIC_KEYS_MAX_BYTES,
  createBrokerMintClient,
  createBrokerServiceHandler,
  mintRequestSha256,
  parseMintEnvelope,
  parseMintRequest,
  parsePublicKeys,
} from "./broker-service";

const U = (n: number) => `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const REQ: MintRequest = {
  site_id: U(1),
  account_id: U(2),
  agent_id: U(3),
  project_id: U(4),
  host_id: U(5),
  run_id: U(6),
  grant_id: U(7),
  lease_id: U(8),
  grant_revision: 3,
};
const ISSUED: MintResult = {
  status: "issued",
  token: "ya29.synthetic-token",
  expires_at: 1_800_000_000_000,
  grant_revision: 3,
  connection_id: U(9),
  project: "fake-project-1",
  sa_label: "ops-reader",
};
const VERSION =
  "projects/fake-project-1/locations/us/keyRings/cocalc-connectors/cryptoKeys/connector-issuer/cryptoKeyVersions/1";
const BAY_A = {
  cluster_id: "cluster-1",
  bay_id: "bay-a",
  bay_credential_id: "cred-a",
};

describe("parseMintRequest", () => {
  it("accepts exactly a mint request", () => {
    expect(parseMintRequest(REQ)).toEqual(REQ);
  });
  it.each([
    ["an extra key", { ...REQ, token: "x" }],
    ["a missing key", { ...REQ, lease_id: undefined }],
    ["a bad uuid", { ...REQ, grant_id: "x" }],
    ["a zero revision", { ...REQ, grant_revision: 0 }],
    ["a string revision", { ...REQ, grant_revision: "3" }],
  ])("refuses %s", (_n, v) => {
    expect(parseMintRequest(v)).toBeUndefined();
  });
});

describe("mint envelope correlation", () => {
  const env = (result: unknown, sha = mintRequestSha256(REQ)) => ({
    request_sha256: sha,
    result,
  });

  it("is the sha256 of the canonical request, independent of key order", () => {
    const shuffled = Object.fromEntries(
      Object.entries(REQ).reverse(),
    ) as MintRequest;
    expect(mintRequestSha256(shuffled)).toBe(mintRequestSha256(REQ));
    expect(mintRequestSha256(REQ)).toMatch(/^[0-9a-f]{64}$/);
    expect(mintRequestSha256({ ...REQ, lease_id: U(99) })).not.toBe(
      mintRequestSha256(REQ),
    );
  });

  it("accepts exactly an envelope for this request", () => {
    expect(parseMintEnvelope(env(ISSUED), REQ)).toEqual(ISSUED);
    expect(
      parseMintEnvelope(env({ status: "denied", reason: "revision" }), REQ),
    ).toEqual({
      status: "denied",
      reason: "revision",
    });
    expect(
      parseMintEnvelope(
        env({ status: "error", reason: "rate", retry_after_ms: 5 }),
        REQ,
      ),
    ).toBeDefined();
  });

  it.each([
    [
      "another request's correlation",
      env(ISSUED, mintRequestSha256({ ...REQ, lease_id: U(99) })),
    ],
    [
      "an uppercase correlation",
      env(ISSUED, mintRequestSha256(REQ).toUpperCase()),
    ],
    ["a short correlation", env(ISSUED, "abc")],
    ["no correlation", { result: ISSUED }],
    ["an extra envelope key", { ...env(ISSUED), extra: 1 }],
    ["an extra result key", env({ ...ISSUED, extra: 1 })],
    ["another grant revision", env({ ...ISSUED, grant_revision: 4 })],
    ["a token with whitespace", env({ ...ISSUED, token: "a b" })],
    ["an unknown status", env({ status: "ok" })],
    [
      "a free-text reason",
      env({ status: "denied", reason: "Denied: provider said X" }),
    ],
    [
      "a negative retry",
      env({ status: "error", reason: "rate", retry_after_ms: -1 }),
    ],
  ])("refuses %s", (_n, v) => {
    expect(parseMintEnvelope(v, REQ)).toBeUndefined();
  });
});

describe("parsePublicKeys", () => {
  const key = { version: VERSION, spki_der_b64: "MIIBIjAN" };
  it("accepts exactly the shape", () => {
    expect(parsePublicKeys({ keys: [key] })).toEqual([key]);
  });
  it.each([
    ["an extra top key", { keys: [key], x: 1 }],
    ["an extra entry key", { keys: [{ ...key, pem: "x" }] }],
    ["a duplicate version", { keys: [key, key] }],
    ["a bad version name", { keys: [{ ...key, version: "v1" }] }],
    ["non-base64 bytes", { keys: [{ ...key, spki_der_b64: "not base64!" }] }],
    [
      "more than 8 keys",
      {
        keys: Array.from({ length: 9 }, (_, i) => ({
          ...key,
          version: VERSION.replace(/1$/, `${i + 1}`),
        })),
      },
    ],
    [
      "more than 16 KiB",
      {
        keys: [
          { ...key, spki_der_b64: "A".repeat(BROKER_PUBLIC_KEYS_MAX_BYTES) },
        ],
      },
    ],
  ])("refuses %s", (_n, v) => {
    expect(parsePublicKeys(v)).toBeUndefined();
  });
});

describe("the broker's handler", () => {
  function setup(home: string | null | Error = "bay-a") {
    const getToken = jest.fn(async (_r: MintRequest) => ISSUED);
    const handler = createBrokerServiceHandler({
      clusterId: "cluster-1",
      homeBayOf: async () => {
        if (home instanceof Error) throw home;
        return home ?? undefined;
      },
      getToken,
      publicKeys: async () => [{ version: VERSION, spki_der_b64: "MIIBIjAN" }],
    });
    return { handler, getToken };
  }

  it("mints for the account's home bay and echoes the correlation", async () => {
    const { handler } = setup();
    const env = await handler.mint(REQ, BAY_A);
    expect(env.request_sha256).toBe(mintRequestSha256(REQ));
    expect(parseMintEnvelope(env, REQ)).toEqual(ISSUED);
  });

  it("hands the core a guard scoped to the caller bay that asks the directory again", async () => {
    let home = "bay-a";
    const lookups: string[] = [];
    const getToken = jest.fn(async (_r: MintRequest, guard: any) => {
      expect(guard.scope).toBe("bay-a");
      expect(await guard.confirmHome()).toBe(true);
      home = "bay-b"; // a rehome between the checks
      expect(await guard.confirmHome()).toBe(false);
      return ISSUED;
    });
    const handler = createBrokerServiceHandler({
      clusterId: "cluster-1",
      homeBayOf: async (account_id) => {
        lookups.push(account_id);
        return home;
      },
      getToken,
      publicKeys: async () => [],
    });
    await handler.mint(REQ, BAY_A);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(lookups).toEqual([REQ.account_id, REQ.account_id, REQ.account_id]);
  });

  it("refuses the exact valid request from another bay, with no broker call", async () => {
    const { handler, getToken } = setup("bay-a");
    await expect(
      handler.mint(REQ, {
        ...BAY_A,
        bay_id: "bay-b",
        bay_credential_id: "cred-b",
      }),
    ).rejects.toThrow("not_home_bay");
    expect(getToken).not.toHaveBeenCalled();
    expect(handler.counters.not_home_bay).toBe(1);
  });

  it("refuses when the home bay can't be resolved", async () => {
    for (const home of [null, Error("directory down")]) {
      const { handler, getToken } = setup(home as any);
      await expect(handler.mint(REQ, BAY_A)).rejects.toThrow("not_home_bay");
      expect(getToken).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["no caller", undefined],
    ["another cluster", { ...BAY_A, cluster_id: "cluster-2" }],
    ["no credential", { ...BAY_A, bay_credential_id: "" }],
    ["an account caller", { account_id: U(2) } as any],
  ])("refuses %s", async (_n, caller) => {
    const { handler, getToken } = setup();
    await expect(handler.mint(REQ, caller)).rejects.toThrow("caller_refused");
    await expect(handler.publicKeys(caller)).rejects.toThrow("caller_refused");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before any work", async () => {
    const { handler, getToken } = setup();
    await expect(handler.mint({ ...REQ, extra: 1 }, BAY_A)).rejects.toThrow(
      "request_refused",
    );
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("the bay's client", () => {
  it("returns the result only for a correlated, well-formed reply", async () => {
    const good = createBrokerMintClient(async () => ({
      request_sha256: mintRequestSha256(REQ),
      result: ISSUED,
    }));
    expect(await good.getToken(REQ)).toEqual(ISSUED);
    const stray = createBrokerMintClient(async () => ({
      request_sha256: mintRequestSha256({ ...REQ, lease_id: U(99) }),
      result: ISSUED,
    }));
    expect(await stray.getToken(REQ)).toEqual({
      status: "error",
      reason: "broker_reply_invalid",
    });
    const down = createBrokerMintClient(async () => {
      throw Error("timeout");
    });
    expect(await down.getToken(REQ)).toEqual({
      status: "error",
      reason: "broker_unavailable",
    });
  });

  it("throws on a malformed publicKeys reply", async () => {
    const bad = createBrokerMintClient(async () => ({ keys: "x" }));
    await expect(bad.publicKeys()).rejects.toThrow("public_keys_invalid");
  });
});
