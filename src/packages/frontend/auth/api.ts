/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
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
  methods: Array<"totp" | "recovery_code">;
  home_bay_id: string;
  home_bay_url?: string;
};

export type AuthBootstrapResponse = {
  signed_in: boolean;
  account_id?: string;
  home_bay_id?: string;
  home_bay_url?: string;
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
    throw new Error(`${json.error}`);
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
