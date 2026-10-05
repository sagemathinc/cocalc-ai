/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Cloudflare connector sign-in and tokens. Each CoCalc site registers its own
// Cloudflare OAuth client (Cloudflare supports only the authorization-code
// flow for third-party clients), so the consent screen names the site. The
// hub is a confidential client: it exchanges the code with the client secret
// (and PKCE), requests only the scopes the user chose, and refreshes the ~1 h
// access tokens. Only access tokens leave the hub. Setup for site admins:
// docs page admin/agent-connectors.

import { createHash, randomBytes } from "node:crypto";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import siteURL from "@cocalc/database/settings/site-url";
import {
  CLOUDFLARE_SCOPE_PRESETS,
  cloudflareScopes,
  type CloudflareScopePreset,
} from "@cocalc/util/ai/cli-connectors";
import { boundedExpiry } from "./cli-connector-github";

const DASH = "https://dash.cloudflare.com";
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
// How long a user has to approve at Cloudflare and come back.
const AUTHORIZATION_MS = 15 * 60_000;
export const CLOUDFLARE_REFRESH_MARGIN_MS = 10 * 60_000;
// The longest access-token lifetime accepted (Cloudflare issues about 1 h).
export const CLOUDFLARE_MAX_ACCESS_SECONDS = 2 * 3600;
/** Where Cloudflare sends the user back; register exactly this URL. */
export const CLOUDFLARE_CALLBACK_PATH = "/settings/connectors";
/** Marks a redirect back from Cloudflare (the state parameter's prefix). */
export const CLOUDFLARE_STATE_PREFIX = "cocalc-cf";

type Fetch = typeof globalThis.fetch;

export interface CloudflareConnectorConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

/** The site's Cloudflare OAuth client, or undefined when not set up. */
export async function getCloudflareConnectorConfig(): Promise<
  CloudflareConnectorConfig | undefined
> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const client_id = `${settings.cloudflare_connector_client_id ?? ""}`.trim();
  const client_secret =
    `${settings.cloudflare_connector_client_secret ?? ""}`.trim();
  if (!client_id || !client_secret) return;
  return {
    client_id,
    client_secret,
    redirect_uri: `${await siteURL()}${CLOUDFLARE_CALLBACK_PATH}`,
  };
}

/** A pending sign-in, kept encrypted on the hub until the user returns. */
export interface CloudflareAuthLogin {
  version: 1;
  type: "cloudflare-oauth-login";
  client_id: string;
  redirect_uri: string;
  /** Proves the redirect belongs to this sign-in. */
  nonce: string;
  code_verifier: string;
  presets: CloudflareScopePreset[];
  expires_at: number;
}

export interface CloudflareConnection {
  version: 2;
  type: "cloudflare-oauth";
  client_id: string;
  presets: CloudflareScopePreset[];
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
}

export function validPresets(input: unknown): CloudflareScopePreset[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw Error("choose what agents may do on Cloudflare");
  }
  const presets = [...new Set(input)];
  for (const preset of presets) {
    if (!Object.hasOwn(CLOUDFLARE_SCOPE_PRESETS, preset)) {
      throw Error(`unknown Cloudflare preset: ${preset}`);
    }
  }
  return presets as CloudflareScopePreset[];
}

export function presetLabels(
  presets: readonly CloudflareScopePreset[],
): string {
  return presets.map((p) => CLOUDFLARE_SCOPE_PRESETS[p].label).join(", ");
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** The state parameter for a sign-in: its id and a secret nonce. */
export function cloudflareState(login_id: string, nonce: string): string {
  return `${CLOUDFLARE_STATE_PREFIX}.${login_id}.${nonce}`;
}

export function parseCloudflareState(
  state: unknown,
): { login_id: string; nonce: string } | undefined {
  if (typeof state !== "string" || state.length > 200) return;
  const [prefix, login_id, nonce, ...rest] = state.split(".");
  if (prefix !== CLOUDFLARE_STATE_PREFIX || !login_id || !nonce || rest.length)
    return;
  return { login_id, nonce };
}

/** A new sign-in and the Cloudflare page where the user approves it. */
export function startCloudflareAuthorization({
  config,
  presets,
  login_id,
  now = Date.now(),
}: {
  config: CloudflareConnectorConfig;
  presets: CloudflareScopePreset[];
  login_id: string;
  now?: number;
}): { login: CloudflareAuthLogin; authorize_url: string } {
  const nonce = base64url(randomBytes(24));
  const code_verifier = base64url(randomBytes(48));
  const challenge = base64url(
    createHash("sha256").update(code_verifier).digest(),
  );
  const url = new URL(`${DASH}/oauth2/auth`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    scope: [...cloudflareScopes(presets), "offline_access"].join(" "),
    state: cloudflareState(login_id, nonce),
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return {
    login: {
      version: 1,
      type: "cloudflare-oauth-login",
      client_id: config.client_id,
      redirect_uri: config.redirect_uri,
      nonce,
      code_verifier,
      presets,
      expires_at: now + AUTHORIZATION_MS,
    },
    authorize_url: url.toString(),
  };
}

function clientAuth(config: CloudflareConnectorConfig): string {
  return `Basic ${Buffer.from(
    `${encodeURIComponent(config.client_id)}:${encodeURIComponent(
      config.client_secret,
    )}`,
  ).toString("base64")}`;
}

async function postToken(
  fetchImpl: Fetch,
  config: CloudflareConnectorConfig,
  form: Record<string, string>,
): Promise<Record<string, any>> {
  const response = await fetchImpl(`${DASH}/oauth2/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: clientAuth(config),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "CoCalc",
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => undefined)) as
    | Record<string, any>
    | undefined;
  if (!body || (!response.ok && !body.error)) {
    throw Error(`Cloudflare sign-in failed (HTTP ${response.status})`);
  }
  return body;
}

function connectionFromTokens(
  body: Record<string, any>,
  previous: { client_id: string; presets: CloudflareScopePreset[] } & {
    refresh_token?: string;
  },
  now: number,
): CloudflareConnection {
  const { access_token } = body;
  const refresh_token =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : previous.refresh_token;
  if (typeof access_token !== "string" || !access_token) {
    throw Error("Cloudflare sign-in failed: no token");
  }
  if (!refresh_token || !body.expires_in) {
    throw Error(
      "Cloudflare sign-in failed: no expiring token (does the site's OAuth client allow offline_access?)",
    );
  }
  const access_expires_at = boundedExpiry(
    now,
    body.expires_in,
    CLOUDFLARE_MAX_ACCESS_SECONDS,
  );
  if (access_expires_at == null) {
    throw Error("Cloudflare returned a token lifetime longer than allowed");
  }
  return {
    version: 2,
    type: "cloudflare-oauth",
    client_id: previous.client_id,
    presets: previous.presets,
    access_token,
    access_expires_at,
    refresh_token,
  };
}

async function revokeIssued(
  config: CloudflareConnectorConfig,
  body: Record<string, any>,
  fetchImpl: Fetch,
): Promise<void> {
  for (const hint of ["refresh_token", "access_token"] as const) {
    const token = body[hint];
    if (typeof token === "string" && token) {
      await revokeCloudflareToken({ config, token, hint, fetchImpl }).catch(
        () => undefined,
      );
    }
  }
}

export type CloudflareExchangeResult =
  | { status: "expired" | "denied" }
  | { status: "connected"; connection: CloudflareConnection };

/** Exchange the code Cloudflare returned for tokens. */
export async function exchangeCloudflareCode({
  config,
  login,
  code,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: CloudflareConnectorConfig;
  login: CloudflareAuthLogin;
  code: string;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<CloudflareExchangeResult> {
  if (
    login.client_id !== config.client_id ||
    login.redirect_uri !== config.redirect_uri ||
    now >= login.expires_at
  ) {
    return { status: "expired" };
  }
  const body = await postToken(fetchImpl, config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: login.redirect_uri,
    code_verifier: login.code_verifier,
  });
  switch (body.error) {
    case undefined:
      break;
    case "invalid_grant":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw Error(`Cloudflare sign-in failed: ${body.error}`);
  }
  try {
    // The caller now owns these tokens: it must store or revoke them.
    return {
      status: "connected",
      connection: connectionFromTokens(body, login, now),
    };
  } catch (err) {
    // A token we will not use should not stay valid either.
    await revokeIssued(config, body, fetchImpl);
    throw err;
  }
}

export async function cloudflareEmail(
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(`${API}/user`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "CoCalc" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => undefined)) as
    | { success?: boolean; result?: { email?: unknown } }
    | undefined;
  if (!response.ok || body?.success !== true) {
    throw Error("Cloudflare did not accept the new sign-in");
  }
  return typeof body.result?.email === "string" ? body.result.email : "";
}

export class CloudflareReconnectRequired extends Error {}

export async function refreshCloudflareConnection({
  config,
  connection,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: CloudflareConnectorConfig;
  connection: CloudflareConnection;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<{ connection: CloudflareConnection; refreshed: boolean }> {
  if (connection.client_id !== config.client_id) {
    throw new CloudflareReconnectRequired(
      "the site's Cloudflare client changed",
    );
  }
  if (connection.access_expires_at - now > CLOUDFLARE_REFRESH_MARGIN_MS) {
    return { connection, refreshed: false };
  }
  const body = await postToken(fetchImpl, config, {
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  });
  if (body.error === "invalid_grant") {
    throw new CloudflareReconnectRequired(
      "Cloudflare sign-in was revoked or expired",
    );
  }
  if (body.error) {
    throw Error(`Cloudflare token refresh failed: ${body.error}`);
  }
  try {
    return {
      connection: connectionFromTokens(body, connection, now),
      refreshed: true,
    };
  } catch (err) {
    // Unusable new tokens are revoked; the connection needs a new sign-in.
    await revokeIssued(config, body, fetchImpl);
    throw new CloudflareReconnectRequired(`${(err as Error).message}`);
  }
}

/** Revoke a token at Cloudflare (by default a refresh token). */
export async function revokeCloudflareToken({
  config,
  token,
  hint = "refresh_token",
  fetchImpl = globalThis.fetch,
}: {
  config: CloudflareConnectorConfig;
  token: string;
  hint?: "refresh_token" | "access_token";
  fetchImpl?: Fetch;
}): Promise<void> {
  const response = await fetchImpl(`${DASH}/oauth2/revoke`, {
    method: "POST",
    headers: {
      authorization: clientAuth(config),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "CoCalc",
    },
    body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Error(`Cloudflare token revocation failed (HTTP ${response.status})`);
  }
}
