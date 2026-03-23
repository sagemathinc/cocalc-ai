/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicContentApp, { getContentViewFromPath } from "./app";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    imprint?: string;
    on_cocalc_com?: boolean;
    policies?: string;
    site_name?: string;
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

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  if (target && /(\/about|\/policies|\/news)/.test(target)) {
    window.history.replaceState({}, "", target);
  }

  const [customize, news] = await Promise.all([loadCustomize(), loadNews()]);
  const root = createRoot(document.getElementById("smc-react-container")!);

  function render(): void {
    root.render(
      <PublicContentApp
        config={customize?.configuration}
        initialNews={news}
        initialView={getContentViewFromPath(window.location.pathname)}
      />,
    );
  }

  window.addEventListener("popstate", render);
  render();
}
