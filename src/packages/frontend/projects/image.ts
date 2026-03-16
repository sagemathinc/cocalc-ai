/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { join } from "path";

export function projectImageUrl(
  blob: string | undefined | null,
  filename = "project-image.png",
): string | undefined {
  const trimmed = `${blob ?? ""}`.trim();
  if (!trimmed) return undefined;
  return `${join(appBasePath, "blobs", encodeURIComponent(filename))}?uuid=${encodeURIComponent(trimmed)}`;
}
