/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Fake values only; no network.

import type { TokenClaims } from "./google-identity";
import {
  checkIssuedToken,
  TokenClaimsCache,
  type GrantIdentity,
  type IssuedClaimsToCheck,
} from "./token-check";

const SA_A = "reader-sa@example-project-1.iam.gserviceaccount.com";
const SA_B = "writer-sa@example-project-2.iam.gserviceaccount.com";
const ID_A = "111111111111111111111";
const ID_B = "222222222222222222222";
const CONN_A = "00000000-0000-4000-8000-00000000000a";
const CONN_B = "00000000-0000-4000-8000-00000000000b";
const CLOUD = "https://www.googleapis.com/auth/cloud-platform";
const NOW = 1_800_000_000_000;

const GRANT_A: GrantIdentity = {
  service_account: SA_A,
  service_account_unique_id: ID_A,
  connection_id: CONN_A,
  target_project: "fake-project-1",
};
const GRANT_B: GrantIdentity = {
  service_account: SA_B,
  service_account_unique_id: ID_B,
  connection_id: CONN_B,
  target_project: "fake-project-2",
};

const claimsFor = (
  id: string,
  extra: Partial<TokenClaims> = {},
): TokenClaims => ({
  azp: id,
  scope: CLOUD,
  expiresInS: 900,
  ...extra,
});

const issuedFor = (
  grant: GrantIdentity,
  extra: Partial<IssuedClaimsToCheck> = {},
): IssuedClaimsToCheck => ({
  token: "ya29.fake-token-T",
  expires_at: NOW + 900_000,
  connection_id: grant.connection_id,
  project: grant.target_project,
  ...extra,
});

function setup(claims: TokenClaims | Error) {
  let mono = 0;
  const cache = new TokenClaimsCache(() => mono);
  const introspect = jest.fn(async (_t: string) => {
    if (claims instanceof Error) throw claims;
    return claims;
  });
  return {
    cache,
    introspect,
    advance: (ms: number) => (mono += ms),
    check: (issued: IssuedClaimsToCheck, grant: GrantIdentity, now = NOW) =>
      checkIssuedToken({ issued, grant, cache, introspect, now: () => now }),
  };
}

describe("checkIssuedToken", () => {
  it("accepts a token whose claims match the fresh grant", async () => {
    const t = setup(claimsFor(ID_A, { aud: ID_A, email: SA_A }));
    await expect(t.check(issuedFor(GRANT_A), GRANT_A)).resolves.toBeUndefined();
    expect(t.introspect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a wrong azp", claimsFor(ID_B), "token_identity"],
    ["a wrong aud", claimsFor(ID_A, { aud: ID_B }), "token_identity"],
    ["a wrong email", claimsFor(ID_A, { email: SA_B }), "token_identity"],
    [
      "an extra scope",
      claimsFor(ID_A, { scope: `${CLOUD} openid` }),
      "token_scope",
    ],
    ["a missing scope", claimsFor(ID_A, { scope: "" }), "token_scope"],
    ["an expired token", claimsFor(ID_A, { expiresInS: 0 }), "token_expiry"],
    ["a too-long token", claimsFor(ID_A, { expiresInS: 3600 }), "token_expiry"],
  ])("refuses %s", async (_name, claims, code) => {
    const t = setup(claims);
    await expect(t.check(issuedFor(GRANT_A), GRANT_A)).rejects.toThrow(code);
  });

  it.each([
    ["a mismatched connection", { connection_id: CONN_B }, "token_connection"],
    ["a mismatched project", { project: "fake-project-2" }, "token_project"],
    [
      "an inconsistent broker expiry",
      { expires_at: NOW + 3_600_000 },
      "token_expiry",
    ],
  ])("refuses %s from the broker", async (_name, extra, code) => {
    const t = setup(claimsFor(ID_A));
    await expect(t.check(issuedFor(GRANT_A, extra), GRANT_A)).rejects.toThrow(
      code,
    );
  });

  it("is unavailable when tokeninfo is unreachable", async () => {
    const t = setup(Error("ya29.fake-token-T unreachable"));
    const err = await t.check(issuedFor(GRANT_A), GRANT_A).catch((e) => e);
    expect(err.message).toBe("tokeninfo_unavailable");
  });

  it("refuses a grant without a unique id", async () => {
    const t = setup(claimsFor(ID_A));
    await expect(
      t.check(issuedFor(GRANT_A), {
        ...GRANT_A,
        service_account_unique_id: "",
      }),
    ).rejects.toThrow("grant_identity_missing");
  });

  it("caches claims, never a verdict: token T accepted for A is refused for B without a second introspection", async () => {
    const t = setup(claimsFor(ID_A));
    await t.check(issuedFor(GRANT_A), GRANT_A);
    await expect(t.check(issuedFor(GRANT_B), GRANT_B)).rejects.toThrow(
      "token_identity",
    );
    expect(t.introspect).toHaveBeenCalledTimes(1);
  });

  it("compares a cache hit with the grant as it is now", async () => {
    const t = setup(claimsFor(ID_A));
    await t.check(issuedFor(GRANT_A), GRANT_A);
    const changed = { ...GRANT_A, service_account_unique_id: ID_B };
    await expect(t.check(issuedFor(GRANT_A), changed)).rejects.toThrow(
      "token_identity",
    );
    const moved = { ...GRANT_A, connection_id: CONN_B };
    await expect(t.check(issuedFor(GRANT_A), moved)).rejects.toThrow(
      "token_connection",
    );
    expect(t.introspect).toHaveBeenCalledTimes(1);
  });

  it("drops a cache entry when the token would expire, by the monotonic clock", async () => {
    const t = setup(claimsFor(ID_A, { expiresInS: 10 }));
    await t.check(issuedFor(GRANT_A, { expires_at: NOW + 10_000 }), GRANT_A);
    expect(t.cache.size).toBe(1);
    t.advance(10_000);
    // Expired by monotonic time: introspected again.
    await t
      .check(issuedFor(GRANT_A, { expires_at: NOW + 10_000 }), GRANT_A)
      .catch(() => {});
    expect(t.introspect).toHaveBeenCalledTimes(2);
  });

  it("never keys the cache by the raw token", () => {
    const cache = new TokenClaimsCache(() => 0);
    cache.set("ya29.secret-value", claimsFor(ID_A), NOW);
    expect(JSON.stringify([...(cache as any).entries.keys()])).not.toContain(
      "secret-value",
    );
  });
});
