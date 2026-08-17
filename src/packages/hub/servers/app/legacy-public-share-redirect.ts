/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import { getLogger } from "@cocalc/hub/logger";
import { resolveLegacyPublicDirectorySharePath } from "@cocalc/server/conat/api/public-directory-shares";
import { joinUrlPath } from "@cocalc/util/url-path";

type LegacyPathResolver = typeof resolveLegacyPublicDirectorySharePath;

const logger = getLogger("hub:servers:app:legacy-public-share-redirect");

function requestSearch(req: Request): string {
  const index = req.url.indexOf("?");
  return index < 0 ? "" : req.url.slice(index);
}

function decodedPathSegments(path: string): string[] {
  const raw = path.replace(/^\/+|\/+$/g, "");
  if (!raw) return [];
  return raw
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (/[\/\\\x00-\x1f\x7f]/.test(decoded)) {
        throw Error("invalid encoded legacy path segment");
      }
      return decoded;
    });
}

function encodedPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

function redirectTarget(path: string): string {
  return joinUrlPath(basePath, path);
}

export default function init(
  router: Router,
  {
    resolve = resolveLegacyPublicDirectorySharePath,
  }: { resolve?: LegacyPathResolver } = {},
): void {
  router.get(/^\/legacy(?:\/.*)?$/, async (req: Request, res: Response) => {
    const pathAfterLegacy = req.path.slice("/legacy".length);
    let segments: string[];
    try {
      segments = decodedPathSegments(pathAfterLegacy);
    } catch {
      res.status(400).send("Invalid legacy URL path.");
      return;
    }

    const originalPath = segments.join("/");
    let resolved: Awaited<ReturnType<LegacyPathResolver>> = null;
    if (originalPath) {
      try {
        resolved = await resolve({ path: originalPath });
      } catch (err) {
        // The compatibility route must not turn a directory/database outage
        // into a regression for every non-share cocalc.com URL.
        logger.warn("legacy public share lookup failed", {
          path: originalPath,
          err: `${(err as Error | undefined)?.message ?? err}`,
        });
      }
    }

    const search = requestSearch(req);
    if (resolved != null) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-CoCalc-Legacy-Redirect", "public-share");
      res.redirect(
        302,
        redirectTarget(
          joinUrlPath("share", encodedPath(resolved.path.split("/"))),
        ) + search,
      );
      return;
    }

    // Preserve the current cocalc.com behavior for paths that are not known
    // legacy shares. Avoid a loop if an old URL itself began with /legacy.
    const fallbackSegments =
      segments[0]?.toLowerCase() === "legacy" ? [] : segments;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-CoCalc-Legacy-Redirect", "path-preserving-fallback");
    res.redirect(302, redirectTarget(encodedPath(fallbackSegments)) + search);
  });
}
