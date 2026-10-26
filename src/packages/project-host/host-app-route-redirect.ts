/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
D7 (trust-free step 6, phase 7b): once the site has app origins, a project's
web server or app is never shown as a page on the project host's own origin.

The host origin carries the visitor's host cookie, which opens every project
of theirs on that host.  A page a user's server served there could read the
visitor's other projects' files and drive their other servers.  So every
browser load of an app route that could become a document (a navigation, a
frame, an object or embed, or anything without fetch metadata) goes to the
site's /app-open instead, whatever authenticates it (cookie, query token or
scoped key), and the app opens on its own app origin.  Only requests with an
explicit Authorization header (CLI, API, agents) are served here as before.

The host's own pages (its CoCalc webapp, exam sessions) keep using app and
file routes with the cookie: they are CoCalc's pages, and with this and the
content view for active files (raw-route-content-redirect.ts) no user content
runs on this origin.
*/

import type { IncomingMessage } from "node:http";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import { classifyProjectRoute } from "./browser-origin-policy";
import { isNavigationRequest } from "./raw-route-content-redirect";

// Marks a redirect from here, so a site that sends it back (no app origin
// for it after all) doesn't loop.
export const HOST_APP_REDIRECT_MARKER = "cocalc_app_redirect";

export type HostAppRouteDecision =
  | { redirect: string }
  | { refuse: number; message: string }
  | undefined;

export function hostAppRouteRedirect({
  req,
  project_id,
  contentDomain,
  siteOrigin,
}: {
  req: Pick<IncomingMessage, "headers" | "method" | "url">;
  project_id: string;
  contentDomain?: string;
  siteOrigin?: string;
}): HostAppRouteDecision {
  if (!contentDomain) return;
  if (`${req.headers.authorization ?? ""}`.trim()) return;
  if (classifyProjectRoute(req, project_id) !== "app") return;
  if (!isNavigationRequest(req)) return;
  let url: URL;
  try {
    url = new URL(`${req.url ?? "/"}`, "http://project-host.local");
  } catch {
    return { refuse: 400, message: "bad request" };
  }
  if (url.searchParams.has(HOST_APP_REDIRECT_MARKER)) {
    return {
      refuse: 503,
      message: "This app can't be opened on its own origin right now.",
    };
  }
  const method = `${req.method ?? "GET"}`.toUpperCase();
  if ((method !== "GET" && method !== "HEAD") || !siteOrigin) {
    return { refuse: 403, message: "open this app from CoCalc" };
  }
  // Never carry a credential into the address bar.
  url.searchParams.delete(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM);
  url.searchParams.set(HOST_APP_REDIRECT_MARKER, "1");
  return { redirect: `${siteOrigin}/app-open${url.pathname}${url.search}` };
}
