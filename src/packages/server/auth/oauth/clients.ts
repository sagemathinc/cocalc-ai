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
  // Both set, or the client gets no purge requests.
  purge?: { url: string; secret: string };
}

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
    },
    defaultRedirectUris: ["https://sagebrush.space/auth/callback"],
    defaultPurgeUrl: "https://sagebrush.space/api/admin/purge",
  },
};

/** Redirect URIs from a setting: whitespace or comma separated absolute http(s)
 * URLs without a fragment or credentials. Anything else is dropped. */
export function parseRedirectUris(value: unknown): string[] {
  return `${value ?? ""}`
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter((uri) => {
      if (!uri) return false;
      try {
        const url = new URL(uri);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    });
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
  const purgeUrl =
    settings[definition.settings.purge_url] == null
      ? definition.defaultPurgeUrl
      : setting(settings, definition.settings.purge_url);
  const purgeSecret = setting(settings, definition.settings.purge_secret);
  return {
    client_id: definition.client_id,
    name: definition.name,
    homepage: definition.homepage,
    client_secret,
    redirect_uris,
    ...(purgeUrl && purgeSecret
      ? { purge: { url: purgeUrl, secret: purgeSecret } }
      : {}),
  };
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
