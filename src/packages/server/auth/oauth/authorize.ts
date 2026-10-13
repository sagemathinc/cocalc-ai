/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
OAuth 2 authorization code flow with PKCE (RFC 6749 and RFC 7636) for the
registered clients in ./clients.ts. See docs/sagebrush.md for the contract.

Approval works across bays like CLI login approval:

1. The browser asks the user's home bay for an approval proof. The home bay
   checks the browser session and the verified email address, records the
   approval and signs a short-lived proof bound to this exact request.
2. The browser sends the proof to the bay serving the authorize page, which
   checks it and stores a one-time code. The client's token request reaches
   the same bay and redeems the code there.
*/

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { getOAuthAccountState, isCurrentEmailVerified } from "./account-state";
import {
  authenticateOAuthClient,
  getOAuthClient,
  getOAuthPurgeClientState,
  isRegisteredRedirectUri,
  type OAuthClient,
} from "./clients";

export const AUTHORIZATION_CODE_TTL_MS = 60_000;
const APPROVAL_PROOF_TTL_SECONDS = 5 * 60;
const MAX_STATE_LENGTH = 512;
// BASE64URL(SHA256(verifier)) is always 43 characters.
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 section 4.1.
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
// Expired codes are kept this long before cleanup, so a late redemption
// attempt still reads "expired" in the logs rather than "unknown".
const CODE_RETENTION_MS = 24 * 60 * 60_000;

/** An authorize request that must not redirect back to the client: the client
 * or redirect URI is not trusted, or the request is malformed. */
export class OAuthAuthorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthAuthorizeError";
  }
}

/** A token request error, with the RFC 6749 error code and HTTP status. */
export class OAuthTokenError extends Error {
  constructor(
    public readonly error:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unsupported_grant_type",
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? error);
    this.name = "OAuthTokenError";
  }
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
}

export interface AuthorizeRequestInfo {
  client_id: string;
  client_name: string;
  client_homepage: string;
  redirect_uri: string;
  redirect_origin: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The authorize request parameters, which the authorize page forwards from
 * its URL query string as `request` in a POST body. */
export function authorizeParams(body: {
  [param: string]: any;
}): Record<string, unknown> {
  const request = body?.request;
  if (request == null || typeof request !== "object" || Array.isArray(request))
    return {};
  return {
    response_type: request.response_type,
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    state: request.state,
    code_challenge: request.code_challenge,
    code_challenge_method: request.code_challenge_method,
  };
}

/** Check the authorize request parameters. Throws OAuthAuthorizeError for
 * anything that must not be redirected back to the client. */
export async function validateAuthorizeRequest(
  params: Record<string, unknown>,
): Promise<AuthorizeRequest> {
  const client = await getOAuthClient(params.client_id);
  if (client == null) {
    throw new OAuthAuthorizeError("unknown client");
  }
  const redirect_uri = str(params.redirect_uri);
  if (!redirect_uri || !isRegisteredRedirectUri(client, redirect_uri)) {
    throw new OAuthAuthorizeError("redirect_uri is not registered");
  }
  if (params.response_type !== "code") {
    throw new OAuthAuthorizeError("response_type must be code");
  }
  if (params.code_challenge_method !== "S256") {
    throw new OAuthAuthorizeError("code_challenge_method must be S256");
  }
  const code_challenge = str(params.code_challenge);
  if (!code_challenge || !CODE_CHALLENGE_RE.test(code_challenge)) {
    throw new OAuthAuthorizeError("invalid code_challenge");
  }
  const state = params.state == null ? undefined : str(params.state);
  if (
    (params.state != null && state == null) ||
    (state?.length ?? 0) > MAX_STATE_LENGTH
  ) {
    throw new OAuthAuthorizeError("invalid state");
  }
  return { client, redirect_uri, state, code_challenge };
}

export function authorizeRequestInfo(
  request: AuthorizeRequest,
): AuthorizeRequestInfo {
  return {
    client_id: request.client.client_id,
    client_name: request.client.name,
    client_homepage: request.client.homepage,
    redirect_uri: request.redirect_uri,
    redirect_origin: new URL(request.redirect_uri).origin,
  };
}

/** Binds an approval proof to one authorize request. `state` is deliberately
 * not part of it: it is opaque to CoCalc and only round-tripped, and the client
 * checks it against its own session (CSRF protection is the client's side of
 * the contract). PKCE's code challenge is what binds the code to the client's
 * request. */
export function authorizeRequestBinding(request: AuthorizeRequest): string {
  return createHash("sha256")
    .update(
      [
        "oauth-authorize-v1",
        request.client.client_id,
        request.redirect_uri,
        request.code_challenge,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

function redirectWith(
  redirect_uri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirect_uri);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function denyRedirectUrl(request: AuthorizeRequest): string {
  return redirectWith(request.redirect_uri, {
    error: "access_denied",
    state: request.state,
  });
}

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type LocalAccountRow = {
  email_address?: string | null;
  email_address_verified?: Record<string, unknown> | null;
  banned?: boolean | null;
  deleted?: boolean | null;
  home_bay_id?: string | null;
};

// Approvals only decide whether the account deletion dialog offers to keep
// the client's data; deletion purges every enabled client either way.
export async function recordOAuthClientApproval({
  db,
  account_id,
  client_id,
}: {
  db: Queryable;
  account_id: string;
  client_id: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO oauth_client_approvals(account_id, client_id, first_approved, last_approved)
     VALUES($1::UUID, $2, NOW(), NOW())
     ON CONFLICT (account_id, client_id) DO UPDATE SET last_approved = NOW()`,
    [account_id, client_id],
  );
}

/** Ids of the clients this account has approved, read on its home bay. */
export async function listOAuthClientApprovals(
  account_id: string,
): Promise<string[]> {
  if (!isValidUUID(account_id)) return [];
  const { rows } = await getPool().query<{ client_id: string }>(
    `SELECT client_id FROM oauth_client_approvals
      WHERE account_id = $1::UUID ORDER BY client_id`,
    [account_id],
  );
  return rows.map((row) => row.client_id);
}

/** Step 1, on the account's home bay: check the account and sign a proof that
 * it approved this authorize request. The caller has already checked that the
 * request comes from a browser session for account_id. */
export async function issueAuthorizeApprovalProof({
  account_id,
  request,
}: {
  account_id: string;
  request: AuthorizeRequest;
}): Promise<{ token: string; home_bay_id: string; expires_at: number }> {
  // No approval, and so no data stored with the client, before the client's
  // purge obligation is recorded; the seed records it within about a minute
  // of the client being configured.
  const state = (await getOAuthPurgeClientState()).find(
    ({ client_id }) => client_id === request.client.client_id,
  );
  if (!state?.obligated) {
    throw Object.assign(
      new Error(
        `${request.client.name} sign-in is still being set up; try again in a minute`,
      ),
      { code: "not_ready" },
    );
  }
  // The account check and the approval record share one transaction under
  // the rehome fence, which also asserts this is the account's home bay.
  const row = await withAccountRehomeWriteFence({
    account_id,
    action: `approve a sign-in to ${request.client.name}`,
    fn: async (db) => {
      const row = (
        await db.query<LocalAccountRow>(
          `SELECT email_address, email_address_verified, banned, deleted, home_bay_id
             FROM accounts WHERE account_id = $1::UUID`,
          [account_id],
        )
      ).rows[0];
      checkApprovingAccount(row);
      await recordOAuthClientApproval({
        db,
        account_id,
        client_id: request.client.client_id,
      });
      return row;
    },
  });
  const issued = issueHomeBayRetryToken({
    account_id,
    email: `${row.email_address}`,
    challenge_id: authorizeRequestBinding(request),
    home_bay_id: getConfiguredBayId(),
    purpose: "oauth-authorize",
    ttl_seconds: APPROVAL_PROOF_TTL_SECONDS,
  });
  return {
    token: issued.token,
    home_bay_id: getConfiguredBayId(),
    expires_at: issued.expires_at,
  };
}

function checkApprovingAccount(
  row: LocalAccountRow | undefined,
): asserts row is LocalAccountRow {
  if (row == null || row.deleted) {
    throw new Error("unknown account");
  }
  if (row.banned) {
    throw new Error("this account cannot sign in to other sites");
  }
  const home_bay_id = `${row.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id !== getConfiguredBayId()) {
    throw new Error("the approval proof must be issued by the home bay");
  }
  if (!isCurrentEmailVerified(row)) {
    throw Object.assign(
      new Error("verify your email address before signing in to other sites"),
      { code: "email_not_verified" },
    );
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Step 2, on the bay serving the authorize page: check the proof, store a
 * one-time code and return the URL to send the browser to. */
export async function approveAuthorizeRequest({
  request,
  approval_token,
  approval_home_bay_id,
}: {
  request: AuthorizeRequest;
  approval_token: string;
  approval_home_bay_id: string;
}): Promise<{ redirect_url: string }> {
  const claims = verifyHomeBayRetryToken({
    token: approval_token,
    home_bay_id: approval_home_bay_id,
    challenge_id: authorizeRequestBinding(request),
    purpose: "oauth-authorize",
  });
  const account_id = `${claims.account_id ?? ""}`.trim();
  const email_address = `${claims.email ?? ""}`.trim();
  if (!isValidUUID(account_id) || !email_address) {
    throw new Error("invalid approval proof");
  }
  const account = await getClusterAccountById(account_id);
  if (`${account?.home_bay_id ?? ""}`.trim() !== claims.home_bay_id) {
    throw new Error("approval proof home bay mismatch");
  }
  const code = randomBytes(32).toString("base64url");
  const pool = getPool();
  await pool.query(`DELETE FROM oauth_authorization_codes WHERE expire < $1`, [
    new Date(Date.now() - CODE_RETENTION_MS),
  ]);
  await pool.query(
    `INSERT INTO oauth_authorization_codes(
       code_hash, client_id, account_id, email_address, redirect_uri,
       code_challenge, created, expire, used_at)
     VALUES($1, $2, $3::UUID, $4, $5, $6, NOW(), $7, NULL)`,
    [
      hashCode(code),
      request.client.client_id,
      account_id,
      email_address,
      request.redirect_uri,
      request.code_challenge,
      new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    ],
  );
  return {
    redirect_url: redirectWith(request.redirect_uri, {
      code,
      state: request.state,
    }),
  };
}

export function pkceChallengeFromVerifier(code_verifier: string): string {
  return createHash("sha256")
    .update(code_verifier, "ascii")
    .digest("base64url");
}

function stringsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface TokenResponse {
  account_id: string;
  email: string;
  email_verified: true;
  name: string;
}

type CodeRow = {
  client_id: string;
  account_id: string;
  email_address: string;
  redirect_uri: string;
  code_challenge: string;
  expire: Date;
};

/** The token endpoint: authenticate the client and redeem the code. A code is
 * used up by its first redemption attempt, even one that fails. */
export async function exchangeAuthorizationCode({
  authorization,
  params,
}: {
  authorization: unknown;
  params: Record<string, unknown>;
}): Promise<TokenResponse> {
  const client = await authenticateOAuthClient(authorization);
  if (client == null) {
    throw new OAuthTokenError("invalid_client", 401);
  }
  if (params.client_id != null && params.client_id !== client.client_id) {
    throw new OAuthTokenError("invalid_client", 401);
  }
  if (params.grant_type !== "authorization_code") {
    throw new OAuthTokenError(
      params.grant_type == null ? "invalid_request" : "unsupported_grant_type",
      400,
    );
  }
  const code = str(params.code);
  const redirect_uri = str(params.redirect_uri);
  const code_verifier = str(params.code_verifier);
  if (!code || !redirect_uri || !code_verifier) {
    throw new OAuthTokenError("invalid_request", 400);
  }
  const { rows } = await getPool().query<CodeRow>(
    `UPDATE oauth_authorization_codes SET used_at = NOW()
      WHERE code_hash = $1 AND used_at IS NULL
      RETURNING client_id, account_id, email_address, redirect_uri,
                code_challenge, expire`,
    [hashCode(code)],
  );
  const row = rows[0];
  if (row == null) {
    throw new OAuthTokenError("invalid_grant", 400, "unknown or used code");
  }
  if (new Date(row.expire).valueOf() <= Date.now()) {
    throw new OAuthTokenError("invalid_grant", 400, "expired code");
  }
  if (row.client_id !== client.client_id) {
    throw new OAuthTokenError("invalid_grant", 400, "client mismatch");
  }
  if (row.redirect_uri !== redirect_uri) {
    throw new OAuthTokenError("invalid_grant", 400, "redirect_uri mismatch");
  }
  if (
    !CODE_VERIFIER_RE.test(code_verifier) ||
    !stringsEqual(pkceChallengeFromVerifier(code_verifier), row.code_challenge)
  ) {
    throw new OAuthTokenError("invalid_grant", 400, "code_verifier mismatch");
  }
  // Ask the account's home bay, not the directory, which can still list an
  // account for a while after its home bay deleted it. Refuse if the account
  // was deleted or banned, or its email address changed or is no longer
  // verified, since it approved.
  const account = await getOAuthAccountState(row.account_id);
  if (
    account.state !== "live" ||
    !account.email_verified ||
    account.email_address.toLowerCase() !==
      row.email_address.trim().toLowerCase()
  ) {
    throw new OAuthTokenError("invalid_grant", 400, "account changed");
  }
  return {
    account_id: row.account_id,
    email: account.email_address,
    email_verified: true,
    name: account.display_name,
  };
}
