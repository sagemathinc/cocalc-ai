/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { ClientProtocolCapabilities } from "@cocalc/util/client-capabilities";

import { siteApiUrl, type NormalizedSiteUrl } from "./site-url";

export interface AuthBootstrapResponse {
  signed_in: boolean;
  account_id?: string;
  email_address?: string;
  display_name?: string;
  home_bay_id?: string;
  home_bay_url?: string;
  client_capabilities?: ClientProtocolCapabilities;
}

export interface ProtocolCompatibility {
  capabilities?: ClientProtocolCapabilities;
  legacy: boolean;
  warning?: string;
}

export function parseProtocolCompatibility(
  value: unknown,
): ProtocolCompatibility {
  const capabilities = (value as AuthBootstrapResponse | undefined)
    ?.client_capabilities;
  if (capabilities == null) {
    return {
      legacy: true,
      warning:
        "This server predates native-client capability discovery. CoCalc will try the version 1 protocol.",
    };
  }
  if (
    capabilities.protocol_version !== 1 ||
    capabilities.browser_challenge_login !== 1 ||
    capabilities.project_window !== 1 ||
    capabilities.project_host_routing !== 1 ||
    capabilities.chat_sync !== 2 ||
    capabilities.agent_session_index !== 1 ||
    capabilities.acp !== 1
  ) {
    throw new Error(
      "This CoCalc server does not provide the native chat protocol required by this app. A server upgrade is required.",
    );
  }
  return { capabilities, legacy: false };
}

async function parseJson(response: Response, url: string): Promise<any> {
  const text = await response.text();
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `CoCalc endpoint ${url} returned HTTP ${response.status}, but did not return JSON.`,
    );
  }
  if (!response.ok || value?.error) {
    const error = new Error(
      `${value?.error ?? `CoCalc endpoint returned HTTP ${response.status}`}`,
    );
    if (value?.code != null) {
      (error as Error & { code?: unknown }).code = value.code;
    }
    throw error;
  }
  return value;
}

export async function postSiteApi<T>({
  site,
  endpoint,
  body,
  cookieHeader,
  signal,
}: {
  site: NormalizedSiteUrl;
  endpoint: string;
  body: object;
  cookieHeader?: string;
  signal?: AbortSignal;
}): Promise<T> {
  const url = siteApiUrl(site, endpoint);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  return (await parseJson(response, url)) as T;
}

export async function getAuthBootstrap({
  site,
  cookieHeader,
  signal,
}: {
  site: NormalizedSiteUrl;
  cookieHeader?: string;
  signal?: AbortSignal;
}): Promise<AuthBootstrapResponse> {
  return await postSiteApi<AuthBootstrapResponse>({
    site,
    endpoint: "auth/bootstrap",
    body: {},
    cookieHeader,
    signal,
  });
}
