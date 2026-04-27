/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicSupportApp, { getSupportViewFromPath } from "./app";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    is_authenticated?: boolean;
    on_cocalc_com?: boolean;
    policy_pages?: string;
    show_policies?: boolean;
    site_name?: string;
    support?: string;
    support_video_call?: string;
    zendesk?: boolean;
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
    target && target.includes("/support") ? target : window.location.pathname;

  const payload = await loadCustomize();
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(pathname = window.location.pathname): void {
    root.render(
      <PublicSupportApp
        config={payload?.configuration}
        initialView={getSupportViewFromPath(pathname)}
      />,
    );
  }

  window.addEventListener("popstate", () => render());
  render(initialPath);
  if (target && target.includes("/support")) {
    window.history.replaceState({}, "", target);
  }
}
