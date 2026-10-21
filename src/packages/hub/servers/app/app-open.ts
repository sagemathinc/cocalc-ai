/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// GET /app-open/<project_id>/<path>[?app=<id>&...]: open a project's web
// server or app on its own app origin (trust-free step 6, phase 7).
//
// From the app itself (Sec-Fetch-Site: same-origin) this issues a single-use
// app capability and redirects to the host's /_a/<capability>, which sets
// the app origin's session.  The host accepts that only as a top-level
// navigation whose Referer is this site, so this redirect keeps the default
// referrer policy (the site's origin is all it sends).
//
// From anywhere else (another site, a content page, a typed URL) it shows a
// small page whose link points back here: the click is same-origin, so a
// third party can't make a victim's browser redeem a link it chose.

import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import getAccountId from "@cocalc/server/auth/get-account";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { issueProjectAppUrl } from "@cocalc/server/conat/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("hub:app-open");

type Issue = typeof issueProjectAppUrl;

function projectUrl(project_id: string): string {
  return `${basePath.replace(/\/+$/, "")}/projects/${project_id}`;
}

export function appOpenConfirmPage(nonce: string): string {
  // No path or name from the request appears here.
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open app</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:15vh auto;max-width:32em;padding:0 1em;color:#333}a{display:inline-block;margin-top:1em;padding:.6em 1.2em;background:#1677ff;color:#fff;border-radius:6px;text-decoration:none}</style>
</head><body>
<h2>Open this app?</h2>
<p>A link is opening a web server or app in one of your CoCalc projects. Continue only if you meant to open it.</p>
<a href="">Open app</a>
</body></html>`;
}

export function initAppOpen(
  router: Router,
  { issue = issueProjectAppUrl }: { issue?: Issue } = {},
) {
  router.get("/app-open/:project_id/*path", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    // Not no-referrer: the host's /_a/ requires this site's origin as
    // Referer (the default policy sends exactly the origin cross-site).
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    const project_id = `${req.params.project_id ?? ""}`;
    if (!isValidUUID(project_id)) {
      res.status(404).send("not found");
      return;
    }
    const prefix = `/app-open/${project_id}/`;
    const i = req.path.indexOf(prefix);
    const rest = i === -1 ? "" : req.path.slice(i + prefix.length);
    const q = req.originalUrl.indexOf("?");
    const params = new URLSearchParams(q === -1 ? "" : req.originalUrl.slice(q + 1));
    const app_id = params.get("app") ?? undefined;
    params.delete("app");
    // Sent here by the project host (D7): never send it back there.
    const fromHost = params.has("cocalc_app_redirect");
    params.delete("cocalc_app_redirect");
    const search = params.toString();
    const path = `/${project_id}/${rest}${search ? `?${search}` : ""}`;
    const fallback = () => res.redirect(302, projectUrl(project_id));
    try {
      const account_id = await getAccountId(req);
      if (!account_id || req.header("Authorization")) return fallback();
      const site = `${req.header("Sec-Fetch-Site") ?? ""}`.toLowerCase();
      const dest = `${req.header("Sec-Fetch-Dest") ?? ""}`.toLowerCase();
      if (dest && dest !== "document") {
        res.status(403).send("forbidden");
        return;
      }
      if (site !== "same-origin") {
        const nonce = randomBytes(16).toString("base64");
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        res.setHeader("X-Frame-Options", "DENY");
        res.type("html").send(appOpenConfirmPage(nonce));
        return;
      }
      const issued = await issue({
        account_id,
        session_hash: getRememberMeHash(req),
        project_id,
        path,
        app_id,
      });
      if (!("url" in issued)) {
        // No app origin for it (the site has none, or the project's host
        // doesn't serve one yet): the app's path on this site, which the hub
        // forwards to the host as before.  The path was validated first.
        if (issued.unavailable === "no-access" || fromHost) return fallback();
        return res.redirect(302, `${basePath.replace(/\/+$/, "")}${path}`);
      }
      res.redirect(302, issued.url);
    } catch (err) {
      logger.debug("app-open fell back to the project", {
        project_id,
        err: `${err}`,
      });
      fallback();
    }
  });
}

export default initAppOpen;
