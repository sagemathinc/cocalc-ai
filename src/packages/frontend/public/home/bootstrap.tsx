/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicHomeApp from "./app";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    is_authenticated?: boolean;
    organization_name?: string;
    organization_url?: string;
    show_policies?: boolean;
    site_description?: string;
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
  const [customize, news] = await Promise.all([loadCustomize(), loadNews()]);
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);
  root.render(
    <PublicHomeApp config={customize?.configuration} initialNews={news} />,
  );
}
