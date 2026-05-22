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

export type AuthBootstrapResponse = {
  signed_in: boolean;
  account_id?: string;
  email_address?: string;
  display_name?: string;
  home_bay_id?: string;
  home_bay_url?: string;
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

function apiUrl(endpoint: string, origin?: string): string {
  const path = `/${joinUrlPath(appBasePath, "api", "v2", endpoint).replace(/^\/+/, "")}`;
  const normalizedOrigin = `${origin ?? ""}`.replace(/\/+$/, "");
  return normalizedOrigin ? `${normalizedOrigin}${path}` : path;
}

export async function postAuthApi<T = any>({
  endpoint,
  body,
  origin,
}: {
  endpoint: string;
  body: object;
  origin?: string;
}): Promise<T> {
  const response = await fetch(apiUrl(endpoint, origin), {
    method: "POST",
    credentials: origin ? "include" : "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (json?.error) {
    const err: any = new Error(`${json.error}`);
    if (json?.code != null) {
      err.code = json.code;
    }
    throw err;
  }
  return json;
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
