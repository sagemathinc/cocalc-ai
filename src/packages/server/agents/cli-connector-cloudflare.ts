/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Cloudflare connector sign-in and tokens: the OAuth device flow of
// Cloudflare's cf CLI with only the scopes the user chose, and its ~1 h access
// tokens, refreshed here on the hub. Only the access token leaves the hub.

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { boundedExpiry } from "./cli-connector-github";
import {
  CLOUDFLARE_SCOPE_PRESETS,
  cloudflareScopes,
  type CloudflareScopePreset,
} from "@cocalc/util/ai/cli-connectors";

const DASH = "https://dash.cloudflare.com";
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
// cf's public OAuth client (no secret); a site may use its own instead.
export const CF_CLI_CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
export const CLOUDFLARE_REFRESH_MARGIN_MS = 10 * 60_000;
// The longest access-token lifetime accepted (Cloudflare issues about 1 h).
export const CLOUDFLARE_MAX_ACCESS_SECONDS = 2 * 3600;

type Fetch = typeof globalThis.fetch;

export interface CloudflareConnectorConfig {
  client_id: string;
}

export async function getCloudflareConnectorConfig(): Promise<
  CloudflareConnectorConfig | undefined
> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const enabled = settings.cloudflare_connector_enabled;
  if (enabled === false || enabled === "no") return;
  const client_id =
    `${settings.cloudflare_connector_client_id ?? ""}`.trim() ||
    CF_CLI_CLIENT_ID;
  return { client_id };
}

export interface CloudflareDeviceLogin {
  version: 1;
  type: "cloudflare-device-login";
  client_id: string;
  device_code: string;
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

async function postForm(
  fetchImpl: Fetch,
  path: string,
  form: Record<string, string>,
): Promise<Record<string, any>> {
  const response = await fetchImpl(`${DASH}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
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

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function trustedVerificationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "dash.cloudflare.com";
  } catch {
    return false;
  }
}

export async function startCloudflareDeviceLogin({
  config,
  presets,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: CloudflareConnectorConfig;
  presets: CloudflareScopePreset[];
  now?: number;
  fetchImpl?: Fetch;
}): Promise<{
  login: CloudflareDeviceLogin;
  user_code: string;
  verification_uri: string;
  interval: number;
}> {
  const body = await postForm(fetchImpl, "/oauth2/device/auth", {
    client_id: config.client_id,
    scope: [...cloudflareScopes(presets), "offline_access"].join(" "),
  });
  if (body.error) throw Error(`Cloudflare sign-in failed: ${body.error}`);
  const { device_code, user_code } = body;
  const verification_uri = trustedVerificationUrl(
    body.verification_uri_complete,
  )
    ? body.verification_uri_complete
    : body.verification_uri;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    !trustedVerificationUrl(verification_uri)
  ) {
    throw Error("Cloudflare sign-in failed: unexpected response");
  }
  return {
    login: {
      version: 1,
      type: "cloudflare-device-login",
      client_id: config.client_id,
      device_code,
      presets,
      expires_at: now + (positive(body.expires_in) || 600) * 1000,
    },
    user_code,
    verification_uri,
    interval: Math.max(5, positive(body.interval)),
  };
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
  if (!refresh_token || !positive(body.expires_in)) {
    throw Error("Cloudflare sign-in failed: no expiring token");
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

export type CloudflarePollResult =
  | { status: "pending"; slow_down?: boolean }
  | { status: "expired" | "denied" }
  | { status: "connected"; connection: CloudflareConnection };

export async function pollCloudflareDeviceLogin({
  config,
  login,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: CloudflareConnectorConfig;
  login: CloudflareDeviceLogin;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<CloudflarePollResult> {
  if (login.client_id !== config.client_id || now >= login.expires_at) {
    return { status: "expired" };
  }
  const body = await postForm(fetchImpl, "/oauth2/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: login.device_code,
    client_id: config.client_id,
  });
  switch (body.error) {
    case undefined:
      break;
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "pending", slow_down: true };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw Error(`Cloudflare sign-in failed: ${body.error}`);
  }
  let connection: CloudflareConnection;
  try {
    connection = connectionFromTokens(body, login, now);
  } catch (err) {
    // A token we will not use should not stay valid either.
    for (const hint of ["refresh_token", "access_token"] as const) {
      const token = body[hint];
      if (typeof token === "string" && token) {
        await revokeCloudflareToken({ config, token, hint, fetchImpl }).catch(
          () => undefined,
        );
      }
    }
    throw err;
  }
  // The caller now owns these tokens: it must store or revoke them.
  return { status: "connected", connection };
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
  const body = await postForm(fetchImpl, "/oauth2/token", {
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
    client_id: config.client_id,
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
    for (const hint of ["refresh_token", "access_token"] as const) {
      const token = body[hint];
      if (typeof token === "string" && token) {
        await revokeCloudflareToken({ config, token, hint, fetchImpl }).catch(
          () => undefined,
        );
      }
    }
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
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "CoCalc",
    },
    body: new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: config.client_id,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Error(`Cloudflare token revocation failed (HTTP ${response.status})`);
  }
}
