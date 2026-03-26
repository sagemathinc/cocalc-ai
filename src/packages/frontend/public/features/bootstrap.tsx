/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicFeaturesApp from "./app";
import { getFeaturesRouteFromPath } from "./routes";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    is_authenticated?: boolean;
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

export async function init(): Promise<void> {
  const target = new URLSearchParams(window.location.search).get("target");
  const initialPath =
    target && target.includes("/features") ? target : window.location.pathname;
  const payload = await loadCustomize();
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(pathname = window.location.pathname): void {
    root.render(
      <PublicFeaturesApp
        config={payload?.configuration}
        initialRoute={getFeaturesRouteFromPath(pathname)}
      />,
    );
  }

  window.addEventListener("popstate", () => render());
  render(initialPath);
  if (target && target.includes("/features")) {
    window.history.replaceState({}, "", target);
  }
}
