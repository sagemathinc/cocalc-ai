/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  clearStoredControlPlaneOrigin,
  getStoredControlPlaneOrigin,
  setStoredControlPlaneOrigin,
  normalizeControlPlaneOrigin,
} from "@cocalc/frontend/control-plane-origin";
import { deleteRememberMe } from "@cocalc/frontend/misc/remember-me";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { AppearancePreference } from "@cocalc/util/appearance";

export type WrongBayAuthResponse = {
  wrong_bay: true;
  home_bay_id: string;
  home_bay_url?: string;
  retry_token: string;
};

export type MfaRequiredAuthResponse = {
  mfa_required: true;
  challenge_id: string;
  methods: SecondFactorMethod[];
  home_bay_id: string;
  home_bay_url?: string;
};

export type SecondFactorMethod = "totp" | "recovery_code" | "passkey";
export type FreshAuthDuration = "default" | "extended";

export type AuthBootstrapResponse = {
  signed_in: boolean;
  account_id?: string;
  email_address?: string;
  email_address_verified?: boolean;
  display_name?: string;
  home_bay_id?: string;
  home_bay_url?: string;
  appearance_theme?: AppearancePreference;
  impersonation?: {
    active: true;
    actor_account_id: string;
    actor_email_address?: string | null;
    actor_name?: string | null;
    subject_account_id: string;
    fresh_auth_until?: string | Date | null;
    factor_level?: "none" | SecondFactorMethod | null;
  } | null;
};

export const AUTH_API_TIMEOUT_MS = 30_000;

export function isWrongBayAuthResponse(
  value: unknown,
): value is WrongBayAuthResponse {
  return (
    !!value && typeof value === "object" && (value as any).wrong_bay === true
  );
}

export function isMfaRequiredAuthResponse(
  value: unknown,
): value is MfaRequiredAuthResponse {
  return (
    !!value &&
    typeof value === "object" &&
    (value as any).mfa_required === true &&
    typeof (value as any).challenge_id === "string"
  );
}

function normalizeAuthOrigin(origin?: string): string {
  const value = String(origin ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Authentication origin must be an absolute HTTP(S) URL, not '${value}'.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Authentication origin must use HTTP(S), not '${url.protocol}'.`,
    );
  }
  return value;
}

function apiUrl(endpoint: string, origin?: string): string {
  const path = `/${joinUrlPath(appBasePath, "api", "v2", endpoint).replace(/^\/+/, "")}`;
  const normalizedOrigin = normalizeAuthOrigin(origin);
  return normalizedOrigin ? `${normalizedOrigin}${path}` : path;
}

function authUrl(endpoint: string, origin?: string): string {
  const path = `/${joinUrlPath(appBasePath, "auth", endpoint).replace(/^\/+/, "")}`;
  const normalizedOrigin = normalizeAuthOrigin(origin);
  return normalizedOrigin ? `${normalizedOrigin}${path}` : path;
}

async function parseAuthResponse<T>(
  response: Response,
  url: string,
): Promise<T> {
  // Some reverse-proxy routing failures return the application HTML shell.
  // Preserve the endpoint and HTTP status instead of exposing JSON.parse noise.
  if (typeof response.text !== "function") {
    return await response.json();
  }
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    const contentType = response.headers?.get?.("content-type") ?? "unknown";
    throw new Error(
      `Authentication endpoint ${url} returned HTTP ${response.status} ${response.statusText || ""} with ${contentType}, not JSON. Refresh the page and try again.`,
    );
  }
}

export async function postAuthApi<T = any>({
  endpoint,
  body,
  origin,
  timeout_ms = AUTH_API_TIMEOUT_MS,
}: {
  endpoint: string;
  body: object;
  origin?: string;
  timeout_ms?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const url = apiUrl(endpoint, origin);
    const response = await fetch(url, {
      method: "POST",
      credentials: origin ? "include" : "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await parseAuthResponse<any>(response, url);
    if (json?.error) {
      const err: any = new Error(`${json.error}`);
      if (json?.code != null) {
        err.code = json.code;
      }
      throw err;
    }
    return json;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        "Authentication request timed out. Check your connection and try again.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startGoogleFreshAuth({
  duration,
  origin,
}: {
  duration: FreshAuthDuration;
  origin?: string;
}): Promise<{ url: string }> {
  const url = `${authUrl("google/fresh-auth/start", origin)}?duration=${encodeURIComponent(duration)}`;
  const response = await fetch(url, {
    method: "POST",
    credentials: origin ? "include" : "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ duration }),
  });
  const json = await parseAuthResponse<any>(response, url);
  if (json?.error) {
    throw new Error(`${json.error}`);
  }
  if (typeof json?.url !== "string" || !json.url) {
    throw new Error("Google verification did not return a start URL.");
  }
  return { url: json.url };
}

export async function retryAuthOnHomeBay<T = any>({
  endpoint,
  wrongBay,
  body,
}: {
  endpoint: string;
  wrongBay: WrongBayAuthResponse;
  body: object;
}): Promise<T> {
  const origin = `${wrongBay.home_bay_url ?? ""}`.trim();
  if (!origin) {
    throw new Error("missing home bay url");
  }
  setStoredControlPlaneOrigin(origin);
  return await postAuthApi<T>({
    endpoint,
    origin,
    body: {
      ...body,
      retry_token: wrongBay.retry_token,
    },
  });
}

export async function getAuthBootstrap(
  origin?: string,
): Promise<AuthBootstrapResponse> {
  return await postAuthApi<AuthBootstrapResponse>({
    endpoint: "auth/bootstrap",
    origin,
    body: {},
  });
}

export async function getControlPlaneAuthBootstrap(): Promise<AuthBootstrapResponse> {
  const storedOrigin = getStoredControlPlaneOrigin();
  if (storedOrigin) {
    try {
      const bootstrap = await getAuthBootstrap(storedOrigin);
      const homeOrigin = normalizeControlPlaneOrigin(bootstrap.home_bay_url);
      if (homeOrigin && homeOrigin !== storedOrigin) {
        setStoredControlPlaneOrigin(homeOrigin);
        try {
          const redirectedBootstrap = await getAuthBootstrap(homeOrigin);
          if (redirectedBootstrap.signed_in) {
            return redirectedBootstrap;
          }
        } catch {}
      }
      if (bootstrap.signed_in) {
        return bootstrap;
      }
    } catch {
      // Fall through to same-origin bootstrap; the stored bay may be stale.
    }
  }

  const bootstrap = await getAuthBootstrap();
  const homeOrigin = normalizeControlPlaneOrigin(bootstrap.home_bay_url);
  if (!homeOrigin) {
    return bootstrap;
  }
  setStoredControlPlaneOrigin(homeOrigin);

  if (bootstrap.signed_in) {
    return bootstrap;
  }

  try {
    return await getAuthBootstrap(homeOrigin);
  } catch {
    return bootstrap;
  }
}

export async function signOutAuthSession({
  all = false,
}: { all?: boolean } = {}): Promise<void> {
  const origin = getStoredControlPlaneOrigin();
  await postAuthApi({
    endpoint: "accounts/sign-out",
    origin,
    body: { all },
  });
  clearStoredControlPlaneOrigin();
  deleteRememberMe(appBasePath);
}
