/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Map } from "immutable";

import { filename_extension, startswith } from "@cocalc/util/misc";
import {
  URL_REJECTED,
  type UrlTransformResult,
} from "@cocalc/frontend/lib/url-transform";

// Resolve "attachment:<name>" URLs against the cell's stored attachments,
// returning a data: URI. Used by both the regular CellInput markdown path and
// the studio cell renderer.
export function attachmentTransform(
  cell: Map<string, any>,
  href?: string,
): UrlTransformResult {
  if (!href || !startswith(href, "attachment:")) {
    return;
  }
  const name = href.slice("attachment:".length);
  const data = cell.getIn(["attachments", name]) as any;
  let ext = filename_extension(name);
  switch (data?.get("type")) {
    case "base64":
      if (ext === "jpg") {
        ext = "jpeg";
      }
      return `data:image/${ext};base64,${data.get("value")}`;
    default:
      // Missing or unsupported attachment: drop the URL.
      return URL_REJECTED;
  }
}
