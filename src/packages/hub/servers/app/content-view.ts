/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// GET /content-view/<project_id>/<path>: a project file shown as its own page.
//
// Project hosts send navigations to non-passive files (HTML, SVG, XML...)
// here instead of showing them on their logged-in origin. This page issues a
// content link for the signed-in user and shows the file in a sandboxed frame
// on the project's content origin. The link is only in the frame's src, never
// in the address bar, history or bookmarks, and printing this page prints the
// frame. If no link can be issued (not signed in, a viewer, content origins
// off, ...), the app's own view of the file takes over.

import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import getAccountId from "@cocalc/server/auth/get-account";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { issueProjectContentUrl } from "@cocalc/server/conat/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";
import { CONTENT_FRAME_SANDBOX } from "@cocalc/util/project-content-origin";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";

const logger = getLogger("hub:content-view");

type Issue = typeof issueProjectContentUrl;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function appFileUrl(project_id: string, encodedPath: string): string {
  return `${basePath.replace(/\/+$/, "")}/projects/${project_id}/files/${encodedPath}`;
}

// Query parameters of the file route that the forwarded query must not set:
// they change how the file is served, or carry credentials.
const RESERVED_QUERY = new Set([
  // Read by this page itself (print once loaded), never by the file.
  "print",
  "download",
  "downloadFilename",
  "deleteAfterDownload",
  "viewer",
  "share",
  PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
]);

// The frame's URL: the issued content link plus the page's own query (minus
// reserved parameters, and never overriding one the link already has).
export function contentFrameUrl(issuedUrl: string, search: string): string {
  const url = new URL(issuedUrl);
  for (const [key, value] of new URLSearchParams(search)) {
    if (RESERVED_QUERY.has(key) || url.searchParams.has(key)) continue;
    url.searchParams.append(key, value);
  }
  return url.toString();
}

export function contentViewPage({
  url,
  nonce,
  print = false,
}: {
  url: string;
  nonce: string;
  // Print once the page, frame included, has loaded (the editor's Print).
  print?: boolean;
}): string {
  // The fragment never reaches the server; the script appends it.
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoCalc</title>
<style nonce="${nonce}">html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>
</head><body>
<iframe id="content" sandbox="${CONTENT_FRAME_SANDBOX}" allow="fullscreen" data-src="${escapeHtml(url)}"></iframe>
<script nonce="${nonce}">(function(){var f=document.getElementById("content");f.src=f.getAttribute("data-src")+location.hash;${print ? 'window.addEventListener("load",function(){window.print();});' : ""}})();</script>
</body></html>`;
}

export function initContentView(
  router: Router,
  { issue = issueProjectContentUrl }: { issue?: Issue } = {},
) {
  router.get(
    "/content-view/:project_id/*path",
    async (req: Request, res: Response) => {
      const project_id = `${req.params.project_id ?? ""}`;
      // The path as the request has it (still URL-encoded).
      const prefix = `/content-view/${project_id}/`;
      const i = req.path.indexOf(prefix);
      const encodedPath = i === -1 ? "" : req.path.slice(i + prefix.length);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (!isValidUUID(project_id) || !encodedPath) {
        res.status(404).send("not found");
        return;
      }
      const fallback = () =>
        res.redirect(302, appFileUrl(project_id, encodedPath));
      let path: string;
      try {
        path = `/${decodeURIComponent(encodedPath)}`;
      } catch {
        res.status(404).send("not found");
        return;
      }
      try {
        const account_id = await getAccountId(req);
        // Signed out, or an API key (not a browser): the app handles it.
        if (!account_id || req.header("Authorization")) return fallback();
        // Only a page of its own issues a link (it can't be framed anyway).
        const dest = `${req.header("Sec-Fetch-Dest") ?? ""}`.toLowerCase();
        if (dest && dest !== "document") return fallback();
        const issued = await issue({
          account_id,
          session_hash: getRememberMeHash(req),
          project_id,
          path,
        });
        if (!("url" in issued)) return fallback();
        const q = req.originalUrl.indexOf("?");
        const url = contentFrameUrl(
          issued.url,
          q === -1 ? "" : req.originalUrl.slice(q + 1),
        );
        const nonce = randomBytes(16).toString("base64");
        const frameOrigin = new URL(issued.url).origin;
        res.setHeader(
          "Content-Security-Policy",
          [
            "default-src 'none'",
            `frame-src ${frameOrigin}`,
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
        );
        res.setHeader("X-Frame-Options", "DENY");
        const print = new URLSearchParams(
          q === -1 ? "" : req.originalUrl.slice(q + 1),
        ).has("print");
        res.type("html").send(contentViewPage({ url, nonce, print }));
      } catch (err) {
        logger.debug("content view fell back to the app", {
          project_id,
          err: `${err}`,
        });
        fallback();
      }
    },
  );
}

export default initContentView;
