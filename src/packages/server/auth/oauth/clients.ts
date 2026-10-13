/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Registered OAuth clients: sites that let people sign in with their CoCalc
// account. Each client is defined here; its secrets and redirect URIs are site
// settings. Only Sagebrush is registered. See docs/sagebrush.md.

import { timingSafeEqual } from "node:crypto";

import { getServerSettings } from "@cocalc/database/settings/server-settings";

export interface OAuthClientDefinition {
  client_id: string;
  // Shown on the authorize page.
  name: string;
  homepage: string;
  // Names of the site settings that configure this client.
  settings: {
    client_secret: string;
    redirect_uris: string;
    purge_url: string;
    purge_secret: string;
    // Set once the client was configured: deleted accounts must be purged
    // from it until an admin clears it to decommission the client.
    purge_obligation: string;
  };
  defaultRedirectUris: string[];
  defaultPurgeUrl: string;
}

export interface OAuthClient {
  client_id: string;
  name: string;
  homepage: string;
  client_secret: string;
  redirect_uris: string[];
  // Set when both the purge URL (an allowed client URL) and the key are;
  // otherwise queued purge requests wait and admins are alerted.
  purge?: { url: string; secret: string };
}

// Removing a client from this registry ends CoCalc's purges of its data: first
// decommission it (see docs/sagebrush.md).
export const OAUTH_CLIENTS: Readonly<Record<string, OAuthClientDefinition>> = {
  sagebrush: {
    client_id: "sagebrush",
    name: "Sagebrush",
    homepage: "https://sagebrush.space",
    settings: {
      client_secret: "sagebrush_client_secret",
      redirect_uris: "sagebrush_redirect_uris",
      purge_url: "sagebrush_purge_url",
      purge_secret: "sagebrush_purge_secret",
      purge_obligation: "sagebrush_purge_obligation",
    },
    defaultRedirectUris: ["https://sagebrush.space/auth/callback"],
    defaultPurgeUrl: "https://sagebrush.space/api/admin/purge",
  },
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a configured URL is an absolute URL without a fragment or
 * credentials, https except for a loopback host (local development). */
export function isAllowedClientUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Redirect URIs from a setting: whitespace or comma separated, each one
 * allowed by isAllowedClientUrl. Anything else is dropped. */
export function parseRedirectUris(value: unknown): string[] {
  return `${value ?? ""}`
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter((uri) => uri && isAllowedClientUrl(uri));
}

function setting(settings: Record<string, unknown>, name: string): string {
  return `${settings[name] ?? ""}`.trim();
}

/** The enabled client with this id, or undefined. A client is enabled when its
 * client secret is set. */
export async function getOAuthClient(
  client_id: unknown,
): Promise<OAuthClient | undefined> {
  if (
    typeof client_id !== "string" ||
    !Object.prototype.hasOwnProperty.call(OAUTH_CLIENTS, client_id)
  ) {
    return;
  }
  const definition = OAUTH_CLIENTS[client_id];
  const settings = (await getServerSettings()) as Record<string, unknown>;
  const client_secret = setting(settings, definition.settings.client_secret);
  if (!client_secret) return;
  const configuredUris = settings[definition.settings.redirect_uris];
  const redirect_uris =
    configuredUris == null
      ? definition.defaultRedirectUris
      : parseRedirectUris(configuredUris);
  const purge = purgeConfig(definition, settings);
  return {
    client_id: definition.client_id,
    name: definition.name,
    homepage: definition.homepage,
    client_secret,
    redirect_uris,
    ...(purge ? { purge } : {}),
  };
}

export interface OAuthPurgeConfig {
  url: string;
  secret: string;
}

function purgeConfig(
  definition: OAuthClientDefinition,
  settings: Record<string, unknown>,
): OAuthPurgeConfig | undefined {
  const url =
    settings[definition.settings.purge_url] == null
      ? definition.defaultPurgeUrl
      : setting(settings, definition.settings.purge_url);
  const secret = setting(settings, definition.settings.purge_secret);
  return url && secret && isAllowedClientUrl(url) ? { url, secret } : undefined;
}

/** Where to send a client's purge requests, or undefined if its purge URL or
 * key is not (validly) set. Independent of the client secret: turning off
 * sign-in must not stop purges of data stored earlier. */
export async function getOAuthClientPurgeConfig(
  client_id: string,
): Promise<OAuthPurgeConfig | undefined> {
  if (!Object.prototype.hasOwnProperty.call(OAUTH_CLIENTS, client_id)) return;
  const settings = (await getServerSettings()) as Record<string, unknown>;
  return purgeConfig(OAUTH_CLIENTS[client_id], settings);
}

/** The clients this site has configured right now, i.e. with a client secret
 * or a purge key, and whether each has its purge obligation recorded. */
export async function getOAuthPurgeClientState(): Promise<
  {
    client_id: string;
    configured: boolean;
    obligation_setting: string;
    obligated: boolean;
  }[]
> {
  const settings = (await getServerSettings()) as Record<string, unknown>;
  return Object.values(OAUTH_CLIENTS).map((definition) => ({
    client_id: definition.client_id,
    configured: !!(
      setting(settings, definition.settings.client_secret) ||
      setting(settings, definition.settings.purge_secret)
    ),
    obligation_setting: definition.settings.purge_obligation,
    obligated: !!setting(settings, definition.settings.purge_obligation),
  }));
}

/** All enabled clients. */
export async function getOAuthClients(): Promise<OAuthClient[]> {
  const clients: OAuthClient[] = [];
  for (const client_id of Object.keys(OAUTH_CLIENTS)) {
    const client = await getOAuthClient(client_id);
    if (client != null) clients.push(client);
  }
  return clients;
}

export function isRegisteredRedirectUri(
  client: OAuthClient,
  redirect_uri: unknown,
): boolean {
  return (
    typeof redirect_uri === "string" &&
    client.redirect_uris.includes(redirect_uri)
  );
}

function secretsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Parse `Authorization: Basic base64(client_id ":" client_secret)`. RFC 6749
 * section 2.3.1 form-urlencodes the id and the secret before joining them, so
 * they are decoded here. */
export function parseBasicAuthorization(
  header: unknown,
): { client_id: string; client_secret: string } | undefined {
  if (typeof header !== "string") return;
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)\s*$/i.exec(header);
  if (!match) return;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return;
  return {
    client_id: formDecode(decoded.slice(0, colon)),
    client_secret: formDecode(decoded.slice(colon + 1)),
  };
}

/** The client authenticated by a Basic authorization header, or undefined if
 * the header is missing or malformed, names an unknown or disabled client, or
 * has the wrong secret. */
export async function authenticateOAuthClient(
  authorization: unknown,
): Promise<OAuthClient | undefined> {
  const credentials = parseBasicAuthorization(authorization);
  if (credentials == null) return;
  const client = await getOAuthClient(credentials.client_id);
  if (client == null) return;
  return secretsEqual(credentials.client_secret, client.client_secret)
    ? client
    : undefined;
}
