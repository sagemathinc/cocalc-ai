/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An upload is written to `<path>.partialupload-<id>` and renamed to <path>
// when it completes, so such names only exist while an upload is in flight.
export const PARTIAL_UPLOAD_MARKER = ".partialupload-";

export function partialUploadPath(path: string, id: string): string {
  return `${path}${PARTIAL_UPLOAD_MARKER}${id}`;
}

export function isPartialUploadName(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(PARTIAL_UPLOAD_MARKER);
  return i > 0 && i + PARTIAL_UPLOAD_MARKER.length < base.length;
}
