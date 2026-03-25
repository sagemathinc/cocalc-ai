/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import PublicLangApp from "./app";
import { loadLangMessages } from "./messages";
import { getLangRouteFromPath, parsePublicLangTarget } from "./routes";

interface CustomizePayload {
  configuration?: {
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
  const parsedTarget = parsePublicLangTarget(target);
  const initialPath =
    parsedTarget != null && target != null ? target : window.location.pathname;
  const initialRoute = getLangRouteFromPath(initialPath);

  const [customize, initialMessages] = await Promise.all([
    loadCustomize(),
    initialRoute.view === "locale"
      ? loadLangMessages(initialRoute.locale)
      : Promise.resolve(undefined),
  ]);

  const root = createRoot(document.getElementById("cocalc-webapp-container")!);

  function render(pathname = window.location.pathname): void {
    root.render(
      <PublicLangApp
        config={customize?.configuration}
        initialMessages={initialMessages}
        initialMessagesLocale={
          initialRoute.view === "locale" ? initialRoute.locale : undefined
        }
        initialRoute={getLangRouteFromPath(pathname)}
      />,
    );
  }

  window.addEventListener("popstate", () => render());
  render(initialPath);
  if (parsedTarget != null && target != null) {
    window.history.replaceState({}, "", target);
  }
}
