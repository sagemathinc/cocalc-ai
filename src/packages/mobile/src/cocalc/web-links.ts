/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { MobileSiteProfile } from "../storage/site-profiles";

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function projectWebUrl(
  profile: MobileSiteProfile,
  projectId: string,
  path?: string,
): string {
  const base = profile.canonical_app_url.replace(/\/+$/, "");
  const encoded = path ? `/${encodePath(path)}` : "";
  return `${base}/projects/${encodeURIComponent(projectId)}/files${encoded}`;
}
