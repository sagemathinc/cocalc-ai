/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The OAuth sign-in flow and purge outbox against a real database (pglite).
// See docs/sagebrush.md.

import { createHash, randomBytes, randomUUID } from "node:crypto";

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
// The real single-bay directory lookup, so deleted and banned accounts behave
// as in production.
// A test can make the directory stale, as it is for a while after a remote
// home bay deleted an account.
const mockStaleDirectory = new Map<string, any>();
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id: string) =>
    mockStaleDirectory.get(account_id) ??
    (await jest
      .requireActual("@cocalc/server/accounts/cluster-directory")
      .getClusterAccountByIdDirect(account_id)),
}));
jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: async () => ({
    class: "free",
    source: "free",
    entitlements: {},
    effective_limits: {},
  }),
}));
const mockAlert = jest.fn();
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAlert(...args),
}));

import {
  approveAuthorizeRequest,
  denyRedirectUrl,
  exchangeAuthorizationCode,
  issueAuthorizeApprovalProof,
  listOAuthClientApprovals,
  OAuthAuthorizeError,
  OAuthTokenError,
  validateAuthorizeRequest,
} from "./authorize";
import {
  deliverDuePurgeRequests,
  getOAuthPurgeTargets,
  queueOAuthClientPurges,
  recordOAuthPurgeObligationsOnSeed,
} from "./purge";
import { getSagebrushLimits } from "@cocalc/server/sagebrush/limits";

const ACK = (init: any) =>
  new Response(
    JSON.stringify({
      request_id: JSON.parse(init.body).request_id,
      status: "accepted",
    }),
    { status: 202 },
  );

const REDIRECT = "https://sagebrush.space/auth/callback";
const SECRET = "client-secret";
const BASIC = `Basic ${Buffer.from(`sagebrush:${SECRET}`).toString("base64")}`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeParams(challenge: string, extra: Record<string, any> = {}) {
  return {
    response_type: "code",
    client_id: "sagebrush",
    redirect_uri: REDIRECT,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  };
}

async function insertAccount({
  verified = true,
  banned = false,
}: { verified?: boolean; banned?: boolean } = {}): Promise<string> {
  const account_id = randomUUID();
  const email_address = `${account_id.slice(0, 8)}@example.com`;
  await getPool().query(
    `INSERT INTO accounts(account_id, email_address, email_address_verified,
                          first_name, last_name, banned, home_bay_id, created)
     VALUES($1, $2, $3, 'Ada', 'Lovelace', $4, 'bay-0', NOW())`,
    [
      account_id,
      email_address,
      verified ? { [email_address]: new Date().toISOString() } : {},
      banned,
    ],
  );
  return account_id;
}

// Run the whole browser side: validate, get the home bay proof, approve.
async function authorize(account_id: string, challenge: string) {
  const request = await validateAuthorizeRequest(authorizeParams(challenge));
  const proof = await issueAuthorizeApprovalProof({ account_id, request });
  const { redirect_url } = await approveAuthorizeRequest({
    request,
    approval_token: proof.token,
    approval_home_bay_id: proof.home_bay_id,
  });
  const url = new URL(redirect_url);
  return { url, code: url.searchParams.get("code")! };
}

function exchange(params: Record<string, any>, authorization = BASIC) {
  return exchangeAuthorizationCode({
    authorization,
    params: { grant_type: "authorization_code", ...params },
  });
}

async function expectTokenError(promise: Promise<unknown>, error: string) {
  await expect(promise).rejects.toBeInstanceOf(OAuthTokenError);
  await promise.catch((err) => expect(err.error).toBe(error));
}

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("sign in with CoCalc (OAuth authorization code with PKCE)", () => {
  beforeAll(async () => {
    await syncSchema({
      accounts: SCHEMA.accounts,
      oauth_authorization_codes: SCHEMA.oauth_authorization_codes,
      oauth_client_approvals: SCHEMA.oauth_client_approvals,
      oauth_client_purge_requests: SCHEMA.oauth_client_purge_requests,
    });
  });

  beforeEach(async () => {
    mockSettings = {
      sagebrush_client_secret: SECRET,
      sagebrush_redirect_uris: REDIRECT,
      sagebrush_purge_url: "https://sagebrush.test/api/admin/purge",
      sagebrush_purge_secret: "purge-key",
    };
    mockAlert.mockReset();
    mockStaleDirectory.clear();
    await getPool().query("DELETE FROM oauth_authorization_codes");
    await getPool().query("DELETE FROM oauth_client_approvals");
    await getPool().query("DELETE FROM oauth_client_purge_requests");
  });

  it("returns the verified account for a valid code, once", async () => {
    const account_id = await insertAccount();
    const { verifier, challenge } = pkce();
    const { url, code } = await authorize(account_id, challenge);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only the hash of the code is stored.
    const stored = await getPool().query(
      "SELECT * FROM oauth_authorization_codes",
    );
    expect(JSON.stringify(stored.rows)).not.toContain(code);

    const result = await exchange({
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(result).toEqual({
      account_id,
      email: `${account_id.slice(0, 8)}@example.com`,
      email_verified: true,
      name: "Ada Lovelace",
    });
    await expectTokenError(
      exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
      "invalid_grant",
    );
    expect(await listOAuthClientApprovals(account_id)).toEqual(["sagebrush"]);
  });

  it("uses up a code on a failed attempt", async () => {
    const account_id = await insertAccount();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(account_id, challenge);
    await expectTokenError(
      exchange({
        code,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      }),
      "invalid_grant",
    );
    await expectTokenError(
      exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
      "invalid_grant",
    );
  });

  it("refuses a different redirect URI, an expired code and a wrong client", async () => {
    const account_id = await insertAccount();
    const first = pkce();
    const a = await authorize(account_id, first.challenge);
    await expectTokenError(
      exchange({
        code: a.code,
        redirect_uri: `${REDIRECT}/x`,
        code_verifier: first.verifier,
      }),
      "invalid_grant",
    );

    const second = pkce();
    const b = await authorize(account_id, second.challenge);
    await getPool().query(
      "UPDATE oauth_authorization_codes SET expire = NOW() - INTERVAL '1 second'",
    );
    await expectTokenError(
      exchange({
        code: b.code,
        redirect_uri: REDIRECT,
        code_verifier: second.verifier,
      }),
      "invalid_grant",
    );

    const third = pkce();
    const c = await authorize(account_id, third.challenge);
    const wrong = `Basic ${Buffer.from("sagebrush:nope").toString("base64")}`;
    await expectTokenError(
      exchange(
        { code: c.code, redirect_uri: REDIRECT, code_verifier: third.verifier },
        wrong,
      ),
      "invalid_client",
    );
    await expectTokenError(
      exchangeAuthorizationCode({
        authorization: undefined,
        params: {
          grant_type: "authorization_code",
          code: c.code,
          redirect_uri: REDIRECT,
          code_verifier: third.verifier,
        },
      }),
      "invalid_client",
    );
    // A client error does not use up the code.
    expect(
      (
        await exchange({
          code: c.code,
          redirect_uri: REDIRECT,
          code_verifier: third.verifier,
        })
      ).account_id,
    ).toBe(account_id);
    await expectTokenError(
      exchangeAuthorizationCode({
        authorization: BASIC,
        params: { grant_type: "password" },
      }),
      "unsupported_grant_type",
    );
    await expectTokenError(
      exchange({ redirect_uri: REDIRECT, code_verifier: third.verifier }),
      "invalid_request",
    );
  });

  it("refuses the token when the account changed after approval", async () => {
    const account_id = await insertAccount();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(account_id, challenge);
    await getPool().query(
      "UPDATE accounts SET email_address = 'new@example.com' WHERE account_id = $1",
      [account_id],
    );
    await expectTokenError(
      exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
      "invalid_grant",
    );
  });

  it("refuses the token when the account was deleted or banned after approval", async () => {
    for (const change of [
      // Only the deleted flag, so the directory lookup itself must refuse.
      "deleted = TRUE",
      // What account deletion really does.
      "deleted = TRUE, email_address = NULL",
      "banned = TRUE",
    ]) {
      const account_id = await insertAccount();
      const { verifier, challenge } = pkce();
      const { code } = await authorize(account_id, challenge);
      await getPool().query(
        `UPDATE accounts SET ${change} WHERE account_id = $1`,
        [account_id],
      );
      await expectTokenError(
        exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
        "invalid_grant",
      );
    }
  });

  it("asks the home bay, not a stale directory entry, at redemption and for limits", async () => {
    const account_id = await insertAccount();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(account_id, challenge);
    expect(await getSagebrushLimits(account_id)).toMatchObject({
      tier: "free",
    });
    const email_address = `${account_id.slice(0, 8)}@example.com`;
    // The home bay deleted the account; the directory still lists it.
    await getPool().query(
      "UPDATE accounts SET deleted = TRUE, email_address = NULL WHERE account_id = $1",
      [account_id],
    );
    mockStaleDirectory.set(account_id, {
      account_id,
      email_address,
      home_bay_id: "bay-0",
    });
    await expectTokenError(
      exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
      "invalid_grant",
    );
    expect(await getSagebrushLimits(account_id)).toBeUndefined();
  });

  it("refuses the token when the email address is no longer verified", async () => {
    const account_id = await insertAccount();
    const { verifier, challenge } = pkce();
    const { code } = await authorize(account_id, challenge);
    await getPool().query(
      "UPDATE accounts SET email_address_verified = '{}'::JSONB WHERE account_id = $1",
      [account_id],
    );
    await expectTokenError(
      exchange({ code, redirect_uri: REDIRECT, code_verifier: verifier }),
      "invalid_grant",
    );
  });

  it("never issues a code for an unverified email address or a banned account", async () => {
    const unverified = await insertAccount({ verified: false });
    const request = await validateAuthorizeRequest(
      authorizeParams(pkce().challenge),
    );
    await expect(
      issueAuthorizeApprovalProof({ account_id: unverified, request }),
    ).rejects.toMatchObject({ code: "email_not_verified" });
    const banned = await insertAccount({ banned: true });
    await expect(
      issueAuthorizeApprovalProof({ account_id: banned, request }),
    ).rejects.toThrow("cannot sign in");
    expect(await listOAuthClientApprovals(unverified)).toEqual([]);
  });

  it("binds the approval proof to the exact request", async () => {
    const account_id = await insertAccount();
    const request = await validateAuthorizeRequest(
      authorizeParams(pkce().challenge),
    );
    const proof = await issueAuthorizeApprovalProof({ account_id, request });
    const other = await validateAuthorizeRequest(
      authorizeParams(pkce().challenge),
    );
    await expect(
      approveAuthorizeRequest({
        request: other,
        approval_token: proof.token,
        approval_home_bay_id: proof.home_bay_id,
      }),
    ).rejects.toThrow("challenge_id mismatch");
  });

  it("rejects bad authorize requests without a redirect", async () => {
    const { challenge } = pkce();
    for (const params of [
      authorizeParams(challenge, { client_id: "other" }),
      authorizeParams(challenge, { redirect_uri: "https://evil.test/cb" }),
      authorizeParams(challenge, { code_challenge_method: "plain" }),
      authorizeParams(challenge, { code_challenge: "short" }),
      authorizeParams(challenge, { response_type: "token" }),
      authorizeParams(challenge, { state: "x".repeat(513) }),
    ]) {
      await expect(validateAuthorizeRequest(params)).rejects.toBeInstanceOf(
        OAuthAuthorizeError,
      );
    }
    mockSettings.sagebrush_client_secret = "";
    await expect(
      validateAuthorizeRequest(authorizeParams(challenge)),
    ).rejects.toThrow("unknown client");
  });

  it("sends Deny back with access_denied and the state", async () => {
    const request = await validateAuthorizeRequest(
      authorizeParams(pkce().challenge),
    );
    expect(denyRedirectUrl(request)).toBe(
      `${REDIRECT}?error=access_denied&state=state-123`,
    );
  });

  describe("purge requests", () => {
    async function approvedAccount(): Promise<string> {
      const account_id = await insertAccount();
      await authorize(account_id, pkce().challenge);
      return account_id;
    }

    it("queues one request per enabled client, approved here or not, unless kept", async () => {
      const a = await approvedAccount();
      const b = await approvedAccount();
      // No approval on this bay, e.g. it was recorded before a rehome.
      const c = await insertAccount();
      const queue = (account_id: string, keep_client_ids?: string[]) =>
        queueOAuthClientPurges({
          db: getPool(),
          account_id,
          client_ids: ["sagebrush"],
          keep_client_ids,
        });
      expect(await queue(a)).toEqual(["sagebrush"]);
      // A retried deletion queues nothing new.
      expect(await queue(a)).toEqual([]);
      expect(await queue(b, ["sagebrush"])).toEqual([]);
      expect(await queue(c)).toEqual(["sagebrush"]);
    });

    it("retries with the same request id until accepted", async () => {
      const account_id = await approvedAccount();
      await queueOAuthClientPurges({
        db: getPool(),
        account_id,
        client_ids: ["sagebrush"],
      });
      const bodies: string[] = [];
      const fail = jest.fn(async (_url, init: any) => {
        bodies.push(init.body);
        return new Response("down", { status: 503 });
      });
      expect(await deliverDuePurgeRequests({ fetch: fail as any })).toEqual({
        accepted: 0,
        failed: 1,
      });
      let row = (
        await getPool().query("SELECT * FROM oauth_client_purge_requests")
      ).rows[0];
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("HTTP 503: down");
      expect(new Date(row.next_attempt_at).valueOf()).toBeGreaterThan(
        Date.now() + 30_000,
      );
      // Not due yet.
      expect(await deliverDuePurgeRequests({ fetch: fail as any })).toEqual({
        accepted: 0,
        failed: 0,
      });

      await getPool().query(
        "UPDATE oauth_client_purge_requests SET next_attempt_at = NOW()",
      );
      // A 202 that does not acknowledge this request is retried.
      const wrongAck = jest.fn(
        async () =>
          new Response('{"request_id":"other","status":"accepted"}', {
            status: 202,
          }),
      );
      expect(await deliverDuePurgeRequests({ fetch: wrongAck as any })).toEqual(
        { accepted: 0, failed: 1 },
      );
      await getPool().query(
        "UPDATE oauth_client_purge_requests SET next_attempt_at = NOW()",
      );
      const ok = jest.fn(async (_url, init: any) => {
        bodies.push(init.body);
        return ACK(init);
      });
      expect(await deliverDuePurgeRequests({ fetch: ok as any })).toEqual({
        accepted: 1,
        failed: 0,
      });
      row = (await getPool().query("SELECT * FROM oauth_client_purge_requests"))
        .rows[0];
      expect(row.accepted_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0])).toEqual({
        account_id,
        request_id: row.request_id,
      });
      expect(mockAlert).not.toHaveBeenCalled();
    });

    it("alerts admins on a 401 and once a request is a day overdue", async () => {
      const account_id = await approvedAccount();
      await queueOAuthClientPurges({
        db: getPool(),
        account_id,
        client_ids: ["sagebrush"],
      });
      const unauthorized = jest.fn(
        async () => new Response("", { status: 401 }),
      );
      await deliverDuePurgeRequests({ fetch: unauthorized as any });
      expect(mockAlert).toHaveBeenCalledTimes(1);

      await getPool().query(
        `UPDATE oauth_client_purge_requests
            SET next_attempt_at = NOW(), created = NOW() - INTERVAL '2 days'`,
      );
      const down = jest.fn(async () => new Response("", { status: 500 }));
      await deliverDuePurgeRequests({ fetch: down as any });
      expect(mockAlert).toHaveBeenCalledTimes(2);
      await getPool().query(
        "UPDATE oauth_client_purge_requests SET next_attempt_at = NOW()",
      );
      await deliverDuePurgeRequests({ fetch: down as any });
      // Overdue alerts are sent once per request.
      expect(mockAlert).toHaveBeenCalledTimes(2);
    });

    it("purges even when sign-in was turned off, before or after the deletion", async () => {
      const deliver = (fetch: any) => deliverDuePurgeRequests({ fetch });
      const ok = jest.fn(async (_url, init: any) => ACK(init));

      // Turned off before the deletion: the client is still a purge target.
      const before = await approvedAccount();
      mockSettings.sagebrush_client_secret = "";
      expect(await getOAuthPurgeTargets()).toEqual(["sagebrush"]);
      await queueOAuthClientPurges({
        db: getPool(),
        account_id: before,
        client_ids: await getOAuthPurgeTargets(),
      });
      expect(await deliver(ok)).toEqual({ accepted: 1, failed: 0 });

      // Turned off after the request was queued.
      mockSettings.sagebrush_client_secret = SECRET;
      const after = await approvedAccount();
      await queueOAuthClientPurges({
        db: getPool(),
        account_id: after,
        client_ids: await getOAuthPurgeTargets(),
      });
      mockSettings.sagebrush_client_secret = "";
      expect(await deliver(ok)).toEqual({ accepted: 1, failed: 0 });
      expect(ok).toHaveBeenCalledTimes(2);
    });

    it("has no purge target on a site that never set up the client", async () => {
      mockSettings = {};
      expect(await getOAuthPurgeTargets()).toEqual([]);
    });

    it("keeps purging after both secrets are blanked, on any bay, until a decommission", async () => {
      // The seed's purge worker records the obligation as a site setting,
      // which every bay (including one added later) receives.
      const setSiteSettings = jest.fn(async (updates: any[]) => {
        for (const { name, value } of updates) mockSettings[name] = value;
      });
      expect(
        await recordOAuthPurgeObligationsOnSeed({ setSiteSettings }),
      ).toEqual(["sagebrush"]);
      expect(mockSettings.sagebrush_purge_obligation).toBeTruthy();
      // Already recorded: nothing more to write.
      expect(
        await recordOAuthPurgeObligationsOnSeed({ setSiteSettings }),
      ).toEqual([]);
      expect(setSiteSettings).toHaveBeenCalledTimes(1);

      // Both secrets blanked; only the propagated obligation remains, as on a
      // bay that never saw the client configured.
      const account_id = await insertAccount();
      mockSettings = {
        sagebrush_purge_obligation: mockSettings.sagebrush_purge_obligation,
      };
      expect(await getOAuthPurgeTargets()).toEqual(["sagebrush"]);
      await queueOAuthClientPurges({
        db: getPool(),
        account_id,
        client_ids: await getOAuthPurgeTargets(),
      });
      const fetch = jest.fn(async (_url, init: any) => ACK(init));
      // Waits while the purge key is missing...
      expect(await deliverDuePurgeRequests({ fetch: fetch as any })).toEqual({
        accepted: 0,
        failed: 1,
      });
      // ...and is delivered once it is restored.
      mockSettings.sagebrush_purge_url =
        "https://sagebrush.test/api/admin/purge";
      mockSettings.sagebrush_purge_secret = "purge-key";
      await getPool().query(
        "UPDATE oauth_client_purge_requests SET next_attempt_at = NOW()",
      );
      expect(await deliverDuePurgeRequests({ fetch: fetch as any })).toEqual({
        accepted: 1,
        failed: 0,
      });
      // Only clearing the obligation (a decommission) removes the target.
      mockSettings = { sagebrush_purge_obligation: "" };
      expect(await getOAuthPurgeTargets()).toEqual([]);
    });

    it("keeps a request queued while the purge is not configured", async () => {
      const account_id = await approvedAccount();
      await queueOAuthClientPurges({
        db: getPool(),
        account_id,
        client_ids: ["sagebrush"],
      });
      mockSettings.sagebrush_purge_secret = "";
      const fetch = jest.fn();
      expect(await deliverDuePurgeRequests({ fetch: fetch as any })).toEqual({
        accepted: 0,
        failed: 1,
      });
      expect(fetch).not.toHaveBeenCalled();
      const row = (
        await getPool().query("SELECT * FROM oauth_client_purge_requests")
      ).rows[0];
      expect(row.accepted_at).toBeNull();
      expect(row.last_error).toContain("not configured");
    });
  });
});
