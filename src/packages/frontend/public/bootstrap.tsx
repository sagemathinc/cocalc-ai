/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicApp from "./app";
import { getPublicAuthRedirectTargetFromSearch } from "./auth/routes";
import type { PublicMembershipTier } from "./pricing/page";
import { getPublicRouteFromPath, isPublicTarget } from "./routes";

interface CustomizePayload {
  configuration?: Record<string, any>;
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

async function loadNews(): Promise<NewsItem[] | undefined> {
  try {
    const resp = await fetch(joinUrlPath(appBasePath, "api/v2/news/list"));
    const payload = await resp.json();
    return Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

async function loadMembershipTiers(): Promise<
  PublicMembershipTier[] | undefined
> {
  try {
    const resp = await fetch(
      joinUrlPath(appBasePath, "api/v2/purchases/get-membership-tiers"),
    );
    const payload = await resp.json();
    return Array.isArray(payload?.tiers) ? payload.tiers : undefined;
  } catch {
    return undefined;
  }
}

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  const initialPath = isPublicTarget(target)
    ? target
    : window.location.pathname + window.location.search;
  const redirectToPath = getPublicAuthRedirectTargetFromSearch(
    window.location.search,
  );
  const initialUrl = new URL(initialPath, "https://example.invalid");
  const initialRoute = getPublicRouteFromPath(
    initialUrl.pathname,
    initialUrl.search,
  );

  const [customize, news, membershipTiers] = await Promise.all([
    loadCustomize(),
    loadNews(),
    initialRoute.section === "info" && initialRoute.route.view === "pricing"
      ? loadMembershipTiers()
      : Promise.resolve(undefined),
  ]);

  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(
    pathname = window.location.pathname,
    search = window.location.search,
  ): void {
    root.render(
      <PublicApp
        config={customize?.configuration}
        initialMembershipTiers={membershipTiers}
        initialNews={news}
        initialRequiresToken={!!customize?.registration}
        initialRoute={getPublicRouteFromPath(pathname, search)}
        redirectToPath={redirectToPath}
      />,
    );
  }

  window.addEventListener("popstate", () =>
    render(window.location.pathname, window.location.search),
  );
  render(initialUrl.pathname, initialUrl.search);
  if (isPublicTarget(target)) {
    window.history.replaceState({}, "", target);
  }
}
