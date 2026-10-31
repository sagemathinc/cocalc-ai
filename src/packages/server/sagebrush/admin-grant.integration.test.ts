/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush's admin scope and admin check against a real database (pglite):
// Sagebrush's admin-visibility plan r1h §1.4, §1.8 and §7a (EP1–EP7), and the
// design review's list (routing failure, account/session mismatch, freshness
// boundaries, revoke, a concurrent single mint, the shared contract pin).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET = "test-home-bay-secret";

import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

let mockSettings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => mockSettings,
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  getConfiguredClusterSeedBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id: string) =>
    await jest
      .requireActual("@cocalc/server/accounts/cluster-directory")
      .getClusterAccountByIdDirect(account_id),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({ class: "free", source: "free", entitlements: {}, effective_limits: {} }),
}));
// (the approving browser session: what getCurrentAuthSession finds for a request)
const mockCurrentSession = jest.fn();
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  ...jest.requireActual("@cocalc/server/auth/auth-sessions"),
  getCurrentAuthSession: (...args: any[]) => mockCurrentSession(...args),
}));
// (the home bay: here unless a test says otherwise; a remote home goes through the inter-bay client)
let mockRemoteHome: string | undefined;
const mockInterBay = { sagebrushAdminMint: jest.fn(), sagebrushAdminAnswer: jest.fn() };
jest.mock("@cocalc/server/accounts/home-bay", () => ({
  ...jest.requireActual("@cocalc/server/accounts/home-bay"),
  remoteHomeBay: async () => mockRemoteHome,
}));
jest.mock("@cocalc/conat/inter-bay/account-facts", () => ({
  ...jest.requireActual("@cocalc/conat/inter-bay/account-facts"),
  createInterBayAccountFactsClient: () => mockInterBay,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({ getInterBayFabricClient: () => ({}) }));

import {
  approveAuthorizeRequest,
  exchangeAuthorizationCode,
  issueAuthorizeApprovalProof,
  OAuthAuthorizeError,
  validateAuthorizeRequest,
} from "@cocalc/server/auth/oauth/authorize";
import {
  getSagebrushAdminAnswer,
  mintSagebrushAdminGrantLocal,
  sagebrushAdminAnswerLocal,
  setSagebrushAdminClock,
} from "./admin-grant";

const CONTRACT_SHA = "9d939a5e431925338626755a6e3fd66bc62f30e4f897603ee3917deeaa207ac5";
const REDIRECT = "https://sagebrush.space/admin/auth/callback";
const SECRET = "client-secret";
const BASIC = `Basic ${Buffer.from(`sagebrush:${SECRET}`).toString("base64")}`;
const now = () => Math.floor(Date.now() / 1000);
const at = (s: number) => new Date(s * 1000);

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
async function admin({ twofa = true, isAdmin = true, deleted = false }: { twofa?: boolean; isAdmin?: boolean; deleted?: boolean } = {}) {
  const account_id = randomUUID();
  const email = `${account_id.slice(0, 8)}@example.com`;
  await getPool().query(
    `INSERT INTO accounts(account_id, email_address, email_address_verified, first_name, last_name, groups, deleted, home_bay_id, created)
     VALUES($1, $2, $3, 'Ada', 'Lovelace', $4, $5, 'bay-0', NOW())`,
    [account_id, email, { [email]: new Date().toISOString() }, isAdmin ? ["admin"] : [], deleted],
  );
  if (twofa) {
    await getPool().query(
      `INSERT INTO account_second_factors(id, account_id, type, label, status, created, activated_at)
       VALUES($1, $2, 'totp', 't', 'active', NOW(), NOW())`,
      [randomUUID(), account_id],
    );
  }
  return account_id;
}
async function session(account_id: string, { F, fresh, expire }: { F: number | null; fresh: number | null; expire: number }) {
  const session_hash = randomBytes(40).toString("hex").slice(0, 127).padEnd(127, "0");
  await getPool().query(
    `INSERT INTO account_auth_sessions(session_hash, account_id, created, updated, expire, authenticated_at, factor_verified_at, fresh_auth_until, factor_level)
     VALUES($1, $2, NOW(), NOW(), $3, NOW(), $4, $5, 'totp')`,
    [session_hash, account_id, at(expire), F == null ? null : at(F), fresh == null ? null : at(fresh)],
  );
  return session_hash;
}
const setSession = (h: string, sql: string, v: any) => getPool().query(`UPDATE account_auth_sessions SET ${sql} WHERE session_hash = $1`, [h, v]);
async function sessionRow(h: string) {
  return (await getPool().query("SELECT * FROM account_auth_sessions WHERE session_hash = $1", [h])).rows[0];
}
/** The browser side for the admin scope: validate, the home bay's proof (from this session), approve. */
async function authorize(account_id: string, h: string, challenge: string, scope: string | undefined = "sagebrush-admin") {
  mockCurrentSession.mockResolvedValue(await sessionRow(h));
  const request = await validateAuthorizeRequest({
    response_type: "code", client_id: "sagebrush", redirect_uri: REDIRECT, state: "s", code_challenge: challenge, code_challenge_method: "S256",
    ...(scope ? { scope } : {}),
  });
  const proof = await issueAuthorizeApprovalProof({ account_id, request, req: {} });
  const { redirect_url } = await approveAuthorizeRequest({ request, approval_token: proof.token, approval_home_bay_id: proof.home_bay_id });
  return new URL(redirect_url).searchParams.get("code")!;
}
const exchange = (code: string, verifier: string) =>
  exchangeAuthorizationCode({ authorization: BASIC, params: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier } });

const describeDb = process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("Sagebrush's admin scope and admin check", () => {
  beforeAll(async () => {
    await syncSchema({
      accounts: SCHEMA.accounts,
      account_auth_sessions: SCHEMA.account_auth_sessions,
      account_second_factors: SCHEMA.account_second_factors,
      oauth_authorization_codes: SCHEMA.oauth_authorization_codes,
      oauth_client_approvals: SCHEMA.oauth_client_approvals,
      oauth_client_purge_requests: SCHEMA.oauth_client_purge_requests,
      sagebrush_admin_grants: SCHEMA.sagebrush_admin_grants,
    });
  });
  beforeEach(async () => {
    mockSettings = {
      sagebrush_client_secret: SECRET,
      sagebrush_redirect_uris: `https://sagebrush.space/auth/callback ${REDIRECT}`,
      sagebrush_purge_url: "https://sagebrush.test/api/admin/purge",
      sagebrush_purge_secret: "purge-key",
      sagebrush_purge_obligation: "2026-10-13T00:00:00.000Z",
    };
    mockRemoteHome = undefined;
    mockInterBay.sagebrushAdminMint.mockReset();
    mockInterBay.sagebrushAdminAnswer.mockReset();
    setSagebrushAdminClock(() => Date.now());
    await getPool().query("DELETE FROM oauth_authorization_codes");
    await getPool().query("DELETE FROM sagebrush_admin_grants");
  });

  it("pins the shared contract fixture (byte-identical with Sagebrush's)", () => {
    const text = readFileSync(join(__dirname, "cocalc-admin-contract.json"));
    expect(createHash("sha256").update(text).digest("hex")).toBe(CONTRACT_SHA);
  });

  // ---- approval
  it("refuses a scope other than sagebrush-admin", async () => {
    await expect(validateAuthorizeRequest({ response_type: "code", client_id: "sagebrush", redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "admin" })).rejects.toBeInstanceOf(OAuthAuthorizeError);
  });
  it("asks for fresh auth when the factor is older than 600 s", async () => {
    const a = await admin(), h = await session(a, { F: now() - 601, fresh: now() + 600, expire: now() + 86400 });
    await expect(authorize(a, h, pkce().challenge)).rejects.toMatchObject({ code: "fresh_auth_required" });
  });
  it("refuses a non-admin and an admin without 2FA", async () => {
    const n = await admin({ isAdmin: false }), hn = await session(n, { F: now() - 10, fresh: now() + 600, expire: now() + 86400 });
    await expect(authorize(n, hn, pkce().challenge)).rejects.toThrow(/only an admin/);
    const t = await admin({ twofa: false }), ht = await session(t, { F: now() - 10, fresh: now() + 600, expire: now() + 86400 });
    await expect(authorize(t, ht, pkce().challenge)).rejects.toMatchObject({ code: "two_factor_required" });
  });
  it("binds the scope: a plain-scope proof can't approve the admin request", async () => {
    const a = await admin(), h = await session(a, { F: now() - 10, fresh: now() + 600, expire: now() + 86400 });
    mockCurrentSession.mockResolvedValue(await sessionRow(h));
    const { challenge } = pkce();
    const base = { response_type: "code", client_id: "sagebrush", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
    const plain = await validateAuthorizeRequest(base);
    const scoped = await validateAuthorizeRequest({ ...base, scope: "sagebrush-admin" });
    const proof = await issueAuthorizeApprovalProof({ account_id: a, request: plain, req: {} });
    await expect(approveAuthorizeRequest({ request: scoped, approval_token: proof.token, approval_home_bay_id: proof.home_bay_id })).rejects.toThrow();
  });

  // ---- minting at token time
  it("EP5: the token's grant expires at min(F + 600, expire, fresh_auth_until)", async () => {
    const a = await admin(), F = now() - 60, h = await session(a, { F, fresh: now() + 120, expire: now() + 86400 });
    const { verifier, challenge } = pkce();
    const r = await exchange(await authorize(a, h, challenge), verifier);
    expect(r.admin_grant).toMatchObject({ factor_verified_at: F, expires_at: now() + 120 });
  });
  it("no grant when the factor changed, fresh_auth_until is NULL, or the session is revoked before redemption", async () => {
    for (const change of [
      (h: string) => setSession(h, "factor_verified_at = $2", at(now() - 30)),
      (h: string) => setSession(h, "fresh_auth_until = $2", null),
      (h: string) => setSession(h, "revoked_at = $2", new Date()),
    ]) {
      const a = await admin(), h = await session(a, { F: now() - 60, fresh: now() + 600, expire: now() + 86400 });
      const { verifier, challenge } = pkce();
      const code = await authorize(a, h, challenge);
      await change(h);
      expect((await exchange(code, verifier)).admin_grant).toBeUndefined();
    }
  });
  it("EP6: a code redeemed twice: the second refused, one grant", async () => {
    const a = await admin(), h = await session(a, { F: now() - 60, fresh: now() + 600, expire: now() + 86400 });
    const { verifier, challenge } = pkce();
    const code = await authorize(a, h, challenge);
    expect((await exchange(code, verifier)).admin_grant).toBeDefined();
    await expect(exchange(code, verifier)).rejects.toMatchObject({ error: "invalid_grant" });
    expect((await getPool().query("SELECT COUNT(*)::INT AS n FROM sagebrush_admin_grants WHERE account_id = $1", [a])).rows[0].n).toBe(1);
  });
  it("EP7: two concurrent redemptions: exactly one succeeds and mints", async () => {
    const a = await admin(), h = await session(a, { F: now() - 60, fresh: now() + 600, expire: now() + 86400 });
    const { verifier, challenge } = pkce();
    const code = await authorize(a, h, challenge);
    const results = await Promise.allSettled([exchange(code, verifier), exchange(code, verifier)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await getPool().query("SELECT COUNT(*)::INT AS n FROM sagebrush_admin_grants WHERE account_id = $1", [a])).rows[0].n).toBe(1);
  });
  it("mints nothing for a session of another account", async () => {
    const a = await admin(), b = await admin(), hb = await session(b, { F: now() - 60, fresh: now() + 600, expire: now() + 86400 });
    expect(await mintSagebrushAdminGrantLocal({ account_id: a, session_hash: hb, factor_verified_at: now() - 60 })).toBeNull();
  });

  // ---- the admin check (EP1–EP4, the window, revoke, account changes)
  async function granted(o: { F?: number; fresh?: number } = {}) {
    const a = await admin(), F = o.F ?? now() - 60;
    const h = await session(a, { F, fresh: o.fresh ?? now() + 600, expire: now() + 86400 });
    const g = await mintSagebrushAdminGrantLocal({ account_id: a, session_hash: h, factor_verified_at: F });
    return { a, h, g: g!, F };
  }
  const refused = { admin: true, two_factor: true };
  it("answers the grant form while every condition holds", async () => {
    const { a, g, F } = await granted();
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual({ admin: true, two_factor: true, factor_verified_at: F, expires_at: g.expires_at });
  });
  it("EP1: fresh_auth_until set NULL after the grant: the refused form", async () => {
    const { a, h, g } = await granted();
    await setSession(h, "fresh_auth_until = $2", null);
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual(refused);
  });
  it("EP2: fresh_auth_until moved before now: the refused form", async () => {
    const { a, h, g } = await granted();
    await setSession(h, "fresh_auth_until = $2", at(now() - 1));
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual(refused);
  });
  it("EP3: fresh_auth_until moved earlier than expires_at but after now: the new value", async () => {
    const { a, h, g } = await granted();
    await setSession(h, "fresh_auth_until = $2", at(now() + 100));
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toMatchObject({ expires_at: now() + 100 });
  });
  it("EP4: fresh_auth_until moved later: capped at the issued expires_at", async () => {
    const { a, h, g } = await granted({ fresh: now() + 120 });
    await setSession(h, "fresh_auth_until = $2", at(now() + 3600));
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toMatchObject({ expires_at: g.expires_at });
  });
  it("the window: admitted at F + 599, refused at F + 600", async () => {
    const { a, g, F } = await granted({ F: now() - 60 });
    setSagebrushAdminClock(() => (F + 599) * 1000);
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toMatchObject({ factor_verified_at: F });
    setSagebrushAdminClock(() => (F + 600) * 1000);
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual(refused);
  });
  it("revoke, expiry, a changed factor, another account's grant: the refused form", async () => {
    for (const change of [
      (h: string) => setSession(h, "revoked_at = $2", new Date()),
      (h: string) => setSession(h, "expire = $2", at(now() - 1)),
      (h: string) => setSession(h, "factor_verified_at = $2", at(now() - 5)),
    ]) {
      const { a, h, g } = await granted();
      await change(h);
      expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual(refused);
    }
    const { g } = await granted();
    const other = await admin();
    expect(await sagebrushAdminAnswerLocal({ account_id: other, grant: g.grant_id })).toEqual(refused);
  });
  it("a deleted admin, an absent account, a demoted one, 2FA off", async () => {
    const d = await admin({ deleted: true });
    expect(await sagebrushAdminAnswerLocal({ account_id: d })).toEqual({ admin: false });
    expect(await sagebrushAdminAnswerLocal({ account_id: randomUUID() })).toEqual({ admin: false });
    const { a, g } = await granted();
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toMatchObject({ admin: true });
    await getPool().query("UPDATE accounts SET groups = '{}' WHERE account_id = $1", [a]);
    expect(await sagebrushAdminAnswerLocal({ account_id: a, grant: g.grant_id })).toEqual({ admin: false });
    const t = await granted();
    await getPool().query("UPDATE account_second_factors SET disabled_at = NOW() WHERE account_id = $1", [t.a]);
    expect(await sagebrushAdminAnswerLocal({ account_id: t.a, grant: t.g.grant_id })).toEqual({ admin: true, two_factor: false });
  });

  // ---- routing
  it("a remote home answers through the inter-bay client; its failure fails closed", async () => {
    const a = await admin();
    mockRemoteHome = "bay-1";
    mockInterBay.sagebrushAdminAnswer.mockResolvedValue({ admin: false });
    expect(await getSagebrushAdminAnswer({ account_id: a, grant: null })).toEqual({ admin: false });
    expect(mockInterBay.sagebrushAdminAnswer).toHaveBeenCalledWith({ account_id: a, grant: null });
    mockInterBay.sagebrushAdminAnswer.mockRejectedValue(Object.assign(new Error("not homed"), { code: 409 }));
    await expect(getSagebrushAdminAnswer({ account_id: a })).rejects.toThrow();
    mockInterBay.sagebrushAdminAnswer.mockRejectedValue(new Error("timeout"));
    await expect(getSagebrushAdminAnswer({ account_id: a })).rejects.toThrow();
  });
  it("a remote home's mint failure gives the token no grant (the code stays used)", async () => {
    const a = await admin(), h = await session(a, { F: now() - 60, fresh: now() + 600, expire: now() + 86400 });
    const { verifier, challenge } = pkce();
    const code = await authorize(a, h, challenge);
    mockRemoteHome = "bay-1";
    mockInterBay.sagebrushAdminMint.mockRejectedValue(new Error("unreachable"));
    expect((await exchange(code, verifier)).admin_grant).toBeUndefined();
    await expect(exchange(code, verifier)).rejects.toMatchObject({ error: "invalid_grant" });
  });
});
