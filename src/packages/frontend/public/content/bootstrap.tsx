/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicContentApp from "./app";
import type { PublicMembershipTier } from "./pricing-page";
import { getContentRouteFromPath, isPublicContentTarget } from "./routes";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    imprint?: string;
    is_authenticated?: boolean;
    on_cocalc_com?: boolean;
    policies?: string;
    site_name?: string;
    show_policies?: boolean;
    terms_of_service_url?: string;
  };
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
  const initialPath = isPublicContentTarget(target)
    ? target
    : window.location.pathname;
  const initialRoute = getContentRouteFromPath(initialPath);

  const [customize, news, membershipTiers] = await Promise.all([
    loadCustomize(),
    loadNews(),
    initialRoute.view === "pricing"
      ? loadMembershipTiers()
      : Promise.resolve(undefined),
  ]);
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(pathname = window.location.pathname): void {
    root.render(
      <PublicContentApp
        config={customize?.configuration}
        initialMembershipTiers={membershipTiers}
        initialNews={news}
        initialRoute={getContentRouteFromPath(pathname)}
      />,
    );
  }

  window.addEventListener("popstate", () => render());
  render(initialPath);
  if (isPublicContentTarget(target)) {
    window.history.replaceState({}, "", target);
  }
}
