/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { SITE_NAME } from "@cocalc/util/theme";
import PublicAuthApp, { getAuthViewFromPath } from "./app";

interface CustomizePayload {
  configuration?: {
    is_authenticated?: boolean;
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

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  const initialPath =
    target && target.includes("/auth") ? target : window.location.pathname;
  const payload = await loadCustomize();
  if (payload?.configuration?.is_authenticated) {
    window.location.replace(joinUrlPath(appBasePath, "projects"));
    return;
  }
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(pathname = window.location.pathname): void {
    root.render(
      <PublicAuthApp
        initialRequiresToken={!!payload?.registration}
        initialView={getAuthViewFromPath(pathname)}
        isAuthenticated={!!payload?.configuration?.is_authenticated}
        siteName={payload?.configuration?.site_name ?? SITE_NAME}
      />,
    );
  }

  window.addEventListener("popstate", () => render());
  render(initialPath);
  if (target && target.includes("/auth")) {
    window.history.replaceState({}, "", target);
  }
}
