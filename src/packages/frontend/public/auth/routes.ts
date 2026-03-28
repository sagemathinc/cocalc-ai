/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AuthView } from "@cocalc/frontend/auth/types";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

export type PublicAuthRoute =
  | { kind: "auth-form"; view: AuthView }
  | { kind: "auth-password-reset-done" }
  | { kind: "auth-password-reset-redeem"; passwordResetId: string }
  | { email?: string; kind: "auth-verify-email"; token: string }
  | { code?: string; kind: "redeem" }
  | { kind: "sso-detail"; id: string }
  | { kind: "sso-index" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  const explicitIndex = Math.max(
    parts.indexOf("auth"),
    parts.indexOf("sso"),
    parts.indexOf("redeem"),
  );
  if (explicitIndex >= 0) {
    return parts.slice(explicitIndex);
  }
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

function normalizeSearch(search?: string): string {
  if (!search) return "";
  return search.startsWith("?") ? search : `?${search}`;
}

function basePathPrefix(): string {
  return appBasePath === "/" ? "" : appBasePath;
}

export function pathForAuthView(view: AuthView): string {
  const base = basePathPrefix();
  switch (view) {
    case "sign-up":
      return `${base}/auth/sign-up`;
    case "password-reset":
      return `${base}/auth/password-reset`;
    case "sign-in":
    default:
      return `${base}/auth/sign-in`;
  }
}

export function pathForPasswordResetDone(): string {
  return `${basePathPrefix()}/auth/password-reset-done`;
}

export function pathForSSO(id?: string): string {
  const base = basePathPrefix();
  return id ? `${base}/sso/${id}` : `${base}/sso`;
}

export function pathForRedeem(code?: string): string {
  const base = basePathPrefix();
  const normalized = `${code ?? ""}`.trim().replace(/^\/+/, "");
  return normalized ? `${base}/redeem/${normalized}` : `${base}/redeem`;
}

export function getPublicAuthRouteFromPath(
  pathname: string,
  search?: string,
): PublicAuthRoute {
  const path = pathname.split("?")[0];
  const url = new URL(
    `https://example.invalid${path}${normalizeSearch(search)}`,
  );
  const routeParts = getRouteParts(url.pathname);

  if (routeParts[0] === "sso") {
    if (routeParts[1]) {
      return { id: routeParts[1], kind: "sso-detail" };
    }
    return { kind: "sso-index" };
  }

  if (routeParts[0] === "auth" && routeParts[1] === "password-reset-done") {
    return { kind: "auth-password-reset-done" };
  }

  if (
    routeParts[0] === "auth" &&
    routeParts[1] === "password-reset" &&
    routeParts[2]
  ) {
    return {
      kind: "auth-password-reset-redeem",
      passwordResetId: routeParts[2],
    };
  }

  if (routeParts[0] === "auth" && routeParts[1] === "verify") {
    return {
      email: url.searchParams.get("email") ?? undefined,
      kind: "auth-verify-email",
      token: routeParts[2] ?? url.searchParams.get("token") ?? "",
    };
  }

  if (routeParts[0] === "redeem") {
    return {
      code: routeParts[1] ?? undefined,
      kind: "redeem",
    };
  }

  if (routeParts[0] === "auth" && routeParts[1] === "sign-up") {
    return { kind: "auth-form", view: "sign-up" };
  }

  if (routeParts[0] === "auth" && routeParts[1] === "password-reset") {
    return { kind: "auth-form", view: "password-reset" };
  }

  return { kind: "auth-form", view: "sign-in" };
}
