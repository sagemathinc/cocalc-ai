/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getPolicyPagesMode } from "@cocalc/frontend/public/ui/policy-pages";
import { joinUrlPath } from "@cocalc/util/url-path";
import { SITE_NAME } from "@cocalc/util/theme";
import PublicAuthApp, { getPublicAuthRouteFromPath } from "./app";

interface CustomizePayload {
  configuration?: {
    is_authenticated?: boolean;
    policy_pages?: string;
    show_policies?: boolean;
    site_name?: string;
  };
  registration?: unknown;
}

async function loadCustomize(): Promise<CustomizePayload | undefined> {
  try {
    const resp = await fetch(joinUrlPath(appBasePath, "customize"));
    return await resp.json();
  } catch {
    return undefined;
  }
}

function appRelativePath(pathname: string): string {
  if (
    appBasePath !== "/" &&
    (pathname === appBasePath || pathname.startsWith(`${appBasePath}/`))
  ) {
    return pathname.slice(appBasePath.length) || "/";
  }
  return pathname;
}

export function getPublicAuthRedirectTargetFromSearch(
  search: string,
  depth = 0,
): string | undefined {
  const target = new URLSearchParams(search).get("target");
  if (!target || !target.startsWith("/") || target.startsWith("//")) {
    return undefined;
  }
  try {
    const url = new URL(target, "https://example.invalid");
    if (url.origin !== "https://example.invalid") {
      return undefined;
    }
    const relative = appRelativePath(url.pathname);
    if (/^\/(auth|sso|redeem)(\/|$)/.test(relative)) {
      // The public auth shell itself is loaded through a target wrapper, e.g.
      // /static/public-auth.html?target=/auth/sign-in?target=/projects/...
      return depth < 3
        ? getPublicAuthRedirectTargetFromSearch(url.search, depth + 1)
        : undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  const redirectToPath = getPublicAuthRedirectTargetFromSearch(
    window.location.search,
  );
  const initialPath =
    target &&
    (target.includes("/auth") ||
      target.includes("/sso") ||
      target.includes("/redeem"))
      ? target
      : window.location.pathname + window.location.search;
  const payload = await loadCustomize();
  const initialUrl = new URL(initialPath, "https://example.invalid");
  const initialRoute = getPublicAuthRouteFromPath(
    initialUrl.pathname,
    initialUrl.search,
  );
  if (
    payload?.configuration?.is_authenticated &&
    initialRoute.kind === "auth-form"
  ) {
    window.location.replace(joinUrlPath(appBasePath, "projects"));
    return;
  }
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(
    pathname = window.location.pathname,
    search = window.location.search,
  ): void {
    root.render(
      <PublicAuthApp
        initialRequiresToken={!!payload?.registration}
        initialRoute={getPublicAuthRouteFromPath(pathname, search)}
        isAuthenticated={!!payload?.configuration?.is_authenticated}
        redirectToPath={redirectToPath}
        showPolicies={getPolicyPagesMode(payload?.configuration) !== "none"}
        siteName={payload?.configuration?.site_name ?? SITE_NAME}
      />,
    );
  }

  window.addEventListener("popstate", () =>
    render(window.location.pathname, window.location.search),
  );
  render(initialUrl.pathname, initialUrl.search);
  if (
    target &&
    (target.includes("/auth") ||
      target.includes("/sso") ||
      target.includes("/redeem"))
  ) {
    window.history.replaceState({}, "", target);
  }
}
