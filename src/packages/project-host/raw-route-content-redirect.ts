/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Opening a project file in its own tab (or following a link to one) goes to
// the logged-in route GET /<project_id>/files/<path>, on an origin that carries
// the user's session. A file that isn't passive (HTML, SVG, the XML family,
// unknown types) must not be shown there as a page: once the site has content
// origins, such a navigation is sent to the hub's content view, which shows
// the file in a sandboxed frame on the project's content origin.

import type { IncomingMessage } from "node:http";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import {
  isPassiveInlineType,
  projectFileResponseName,
} from "@cocalc/conat/files/file-response-type";

// Sec-Fetch-Dest values of subresource loads. Anything else (document,
// iframe, frame, embed, object, fencedframe, future values, or no header at
// all) is treated as a navigation.
const SUBRESOURCE_DESTINATIONS = new Set([
  "audio",
  "audioworklet",
  "empty",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
]);

export function isNavigationRequest(req: Pick<IncomingMessage, "headers">) {
  const dest = `${req.headers["sec-fetch-dest"] ?? ""}`.trim().toLowerCase();
  return !SUBRESOURCE_DESTINATIONS.has(dest);
}

function originOf(value: unknown): string | undefined {
  try {
    const url = new URL(`${value ?? ""}`);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return;
  }
}

// The site whose content view to use: the page the user came from, if it's
// one of the host's approved sites, else the configured site. With the site's
// base path (a hub served under /base serves /base/content-view).
export function contentViewSiteOrigin({
  req,
  approvedOrigins,
  siteUrl,
}: {
  req: Pick<IncomingMessage, "headers">;
  approvedOrigins: Set<string>;
  siteUrl?: string;
}): string | undefined {
  let basePath = "";
  try {
    basePath = new URL(`${siteUrl ?? ""}`).pathname.replace(/\/+$/, "");
  } catch {}
  const referer = originOf(req.headers.referer);
  if (referer && approvedOrigins.has(referer)) return `${referer}${basePath}`;
  const site = originOf(siteUrl);
  return site ? `${site}${basePath}` : undefined;
}

// The content-view URL to redirect to, or undefined to serve the file here.
export function rawRouteContentRedirect({
  req,
  project_id,
  contentDomain,
  siteOrigin,
  share,
}: {
  req: Pick<IncomingMessage, "headers" | "method" | "url">;
  project_id: string;
  contentDomain?: string;
  siteOrigin?: string;
  // Public directory shares have no project view to go to (their readers
  // needn't be members): their non-passive files are shown in an opaque
  // origin instead (handleFileDownload nonPassive "sandbox").
  share?: boolean;
}): string | undefined {
  if (!contentDomain || !siteOrigin || share) return;
  if (!/^GET$/i.test(req.method ?? "GET")) return;
  // CLI, agents and API keys: browsers never add this header to a navigation.
  if (req.headers.authorization) return;
  if (!isNavigationRequest(req)) return;
  const url = `${req.url ?? ""}`;
  const prefix = `/${project_id}/files/`;
  if (!url.startsWith(prefix)) return;
  const q = url.indexOf("?");
  const encodedPath = url.slice(prefix.length, q === -1 ? undefined : q);
  let path: string;
  try {
    path = `/${decodeURIComponent(encodedPath)}`;
  } catch {
    return;
  }
  const { contentType, download } = projectFileResponseName({ path, url });
  if (download || isPassiveInlineType(contentType)) return;
  // Never carry a credential into the address bar of the content view.
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  params.delete(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM);
  const search = params.toString();
  return `${siteOrigin}/content-view/${project_id}/${encodedPath}${search ? `?${search}` : ""}`;
}
