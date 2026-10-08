/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An upload is written to `<path>.partialupload-<id>` and renamed to <path>
// when it completes, so such names only exist while an upload is in flight.
export const PARTIAL_UPLOAD_MARKER = ".partialupload-";

// Matches exactly the ids the uploader uses (randomId() in
// @cocalc/conat/names: 10 characters from its alphabet), so ordinary files
// such as "notes.partialupload-final" are never mistaken for uploads.
const PARTIAL_UPLOAD_NAME = /.\.partialupload-[2-9A-HJ-NP-Z]{10}$/;

export function partialUploadPath(path: string, id: string): string {
  return `${path}${PARTIAL_UPLOAD_MARKER}${id}`;
}

export function isPartialUploadName(name: string): boolean {
  return PARTIAL_UPLOAD_NAME.test(name.slice(name.lastIndexOf("/") + 1));
}
