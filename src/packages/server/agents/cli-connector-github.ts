/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// GitHub connector sign-in and tokens: the site's GitHub App, its device flow,
// and GitHub's expiring user tokens (8 h), refreshed here on the hub. Only the
// short-lived access token ever leaves the hub. Setup for site admins: docs
// page admin/agent-connectors.

import { getServerSettings } from "@cocalc/database/settings/server-settings";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
// Refresh when less than this remains, so a turn token is good for a while.
export const GITHUB_REFRESH_MARGIN_MS = 15 * 60_000;

type Fetch = typeof globalThis.fetch;

export interface GithubConnectorConfig {
  client_id: string;
  client_secret: string;
  app_url: string;
}

/** The site's GitHub App, or undefined when the connector is not set up. */
export async function getGithubConnectorConfig(): Promise<
  GithubConnectorConfig | undefined
> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const client_id = `${settings.github_connector_client_id ?? ""}`.trim();
  const client_secret =
    `${settings.github_connector_client_secret ?? ""}`.trim();
  const app_url = `${settings.github_connector_app_url ?? ""}`.trim();
  if (!client_id || !client_secret) return;
  return { client_id, client_secret, app_url };
}

/** Pending device sign-in, kept encrypted on the hub until it completes. */
export interface GithubDeviceLogin {
  version: 1;
  type: "github-device-login";
  client_id: string;
  device_code: string;
  expires_at: number;
}

/** A connection: GitHub's user tokens for the site's app. */
export interface GithubAppConnection {
  version: 2;
  type: "github-app";
  client_id: string;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
  refresh_expires_at: number;
}

async function postForm(
  fetchImpl: Fetch,
  path: string,
  form: Record<string, string>,
): Promise<Record<string, any>> {
  const response = await fetchImpl(`${GITHUB}${path}`, {
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
    throw Error(`GitHub sign-in failed (HTTP ${response.status})`);
  }
  return body;
}

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function startGithubDeviceLogin({
  config,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: GithubConnectorConfig;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<{
  login: GithubDeviceLogin;
  user_code: string;
  verification_uri: string;
  interval: number;
}> {
  const body = await postForm(fetchImpl, "/login/device/code", {
    client_id: config.client_id,
  });
  if (body.error) {
    throw Error(
      body.error === "device_flow_disabled"
        ? "The site's GitHub App does not have Device Flow enabled"
        : `GitHub sign-in failed: ${body.error}`,
    );
  }
  const { device_code, user_code, verification_uri } = body;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    !verification_uri.startsWith(`${GITHUB}/`)
  ) {
    throw Error("GitHub sign-in failed: unexpected response");
  }
  return {
    login: {
      version: 1,
      type: "github-device-login",
      client_id: config.client_id,
      device_code,
      expires_at: now + (positive(body.expires_in) || 900) * 1000,
    },
    user_code,
    verification_uri,
    interval: Math.max(5, positive(body.interval)),
  };
}

function connectionFromTokens(
  body: Record<string, any>,
  client_id: string,
  now: number,
): GithubAppConnection {
  const { access_token, refresh_token } = body;
  if (typeof access_token !== "string" || !access_token) {
    throw Error("GitHub sign-in failed: no token");
  }
  if (
    typeof refresh_token !== "string" ||
    !refresh_token ||
    !positive(body.expires_in)
  ) {
    // Only expiring tokens may reach a project.
    throw Error(
      "The site's GitHub App must have 'Expire user authorization tokens' turned on",
    );
  }
  return {
    version: 2,
    type: "github-app",
    client_id,
    access_token,
    access_expires_at: now + positive(body.expires_in) * 1000,
    refresh_token,
    refresh_expires_at:
      now + (positive(body.refresh_token_expires_in) || 15_811_200) * 1000,
  };
}

export type GithubPollResult =
  | { status: "pending"; slow_down?: boolean }
  | { status: "expired" | "denied" }
  | { status: "connected"; connection: GithubAppConnection; login: string };

export async function pollGithubDeviceLogin({
  config,
  login,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: GithubConnectorConfig;
  login: GithubDeviceLogin;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<GithubPollResult> {
  if (login.client_id !== config.client_id || now >= login.expires_at) {
    return { status: "expired" };
  }
  const body = await postForm(fetchImpl, "/login/oauth/access_token", {
    client_id: config.client_id,
    device_code: login.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
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
      throw Error(`GitHub sign-in failed: ${body.error}`);
  }
  let connection: GithubAppConnection;
  try {
    connection = connectionFromTokens(body, config.client_id, now);
  } catch (err) {
    // A token we will not use should not stay valid either.
    if (typeof body.access_token === "string") {
      await revokeGithubToken({
        config,
        token: body.access_token,
        fetchImpl,
      }).catch(() => undefined);
    }
    throw err;
  }
  return {
    status: "connected",
    connection,
    login: await githubLogin(connection.access_token, fetchImpl),
  };
}

export async function githubLogin(
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(`${GITHUB_API}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "CoCalc",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const user = (await response.json().catch(() => undefined)) as
    | { login?: unknown }
    | undefined;
  if (!response.ok || typeof user?.login !== "string" || !user.login) {
    throw Error("GitHub did not accept the new sign-in");
  }
  return user.login;
}

export class GithubReconnectRequired extends Error {}

/**
 * The connection with an access token good for at least the refresh margin,
 * refreshing it if needed. Throws GithubReconnectRequired when GitHub refuses
 * the refresh token or the site's app changed.
 */
export async function refreshGithubConnection({
  config,
  connection,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
}: {
  config: GithubConnectorConfig;
  connection: GithubAppConnection;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<{ connection: GithubAppConnection; refreshed: boolean }> {
  if (connection.client_id !== config.client_id) {
    throw new GithubReconnectRequired("the site's GitHub App changed");
  }
  if (connection.access_expires_at - now > GITHUB_REFRESH_MARGIN_MS) {
    return { connection, refreshed: false };
  }
  if (now >= connection.refresh_expires_at) {
    throw new GithubReconnectRequired("GitHub sign-in expired");
  }
  const body = await postForm(fetchImpl, "/login/oauth/access_token", {
    client_id: config.client_id,
    client_secret: config.client_secret,
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  });
  if (body.error === "bad_refresh_token") {
    throw new GithubReconnectRequired("GitHub sign-in was revoked or expired");
  }
  if (body.error) throw Error(`GitHub token refresh failed: ${body.error}`);
  return {
    connection: connectionFromTokens(body, config.client_id, now),
    refreshed: true,
  };
}

/** Invalidate a user token at GitHub (needs the app's client secret). */
export async function revokeGithubToken({
  config,
  token,
  fetchImpl = globalThis.fetch,
}: {
  config: GithubConnectorConfig;
  token: string;
  fetchImpl?: Fetch;
}): Promise<void> {
  const basic = Buffer.from(
    `${config.client_id}:${config.client_secret}`,
  ).toString("base64");
  const response = await fetchImpl(
    `${GITHUB_API}/applications/${encodeURIComponent(config.client_id)}/token`,
    {
      method: "DELETE",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "CoCalc",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw Error(`GitHub token revocation failed (HTTP ${response.status})`);
  }
}
