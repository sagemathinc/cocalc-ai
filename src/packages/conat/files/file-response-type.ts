/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import mime from "mime-types";
import { path_split } from "@cocalc/util/misc";

// The one place that decides which name and type a project file is served
// with: the response and the logged-in route's "is this safe inline?" check
// must agree, or a passive path could be served with an active type.
export function projectFileResponseName({
  path,
  url,
}: {
  path: string;
  url: string;
}): { fileName: string; contentType: string | false; download: boolean } {
  let download = false;
  let downloadFilename: string | undefined;
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    download = parsed.searchParams.has("download");
    // Only a download (an attachment) may be renamed: the name sets the type,
    // so honouring it inline would serve any file as, say, HTML.
    const name = parsed.searchParams.get("downloadFilename");
    if (download && name) downloadFilename = path_split(name).tail;
  } catch {}
  const fileName = downloadFilename || path_split(path).tail;
  return { fileName, contentType: mime.lookup(fileName), download };
}

// Types a browser shows as a document without running anything from the file.
// Everything else (HTML, SVG, the XML family, unknown types) must not be shown
// inline on an origin that carries the user's session.
const PASSIVE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export function isPassiveInlineType(contentType: string | false): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (
    PASSIVE_TYPES.has(type) ||
    type.startsWith("audio/") ||
    type.startsWith("video/")
  );
}
