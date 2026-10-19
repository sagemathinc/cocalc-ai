/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { path as STATIC_PATH } from "@cocalc/static";

// Cache successful resolution only: a build finishing after hub startup is
// still picked up. The shell and Markdown endpoints use the same release.
let resolvedStaticPath: string | undefined;

export function resolveStaticPath(): string {
  if (resolvedStaticPath != null) return resolvedStaticPath;
  const candidates: string[] = [];
  if (process.env.COCALC_STATIC_PATH)
    candidates.push(process.env.COCALC_STATIC_PATH);
  if (process.env.COCALC_BUNDLE_DIR)
    candidates.push(join(process.env.COCALC_BUNDLE_DIR, "static"));
  candidates.push(
    STATIC_PATH,
    join(process.cwd(), "static"),
    join(process.cwd(), "packages", "static", "dist"),
    join(__dirname, "..", "static"),
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "app.html"))) {
      resolvedStaticPath = candidate;
      return candidate;
    }
  }
  return STATIC_PATH;
}
