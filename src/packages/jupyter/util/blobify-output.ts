/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
How kernel output data is prepared before browsers see it: images, PDFs and
HTML that needs isolation are moved to the blob store and replaced by the
blob's sha1 (isolated HTML becomes an "iframe" output).  Used by
JupyterActions.processOutput, and by tests that need to see outputs exactly
as the project prepares them.
*/

import { isSha1, sha1 } from "@cocalc/util/misc";
import { shouldUseIframe } from "./iframe";
import { JUPYTER_MIMETYPES, isJupyterBase64MimeType } from "./misc";

// Decode a MIME value into the bytes that go into the blob store.
export function outputBlobBytes(data: string, type: string): Buffer {
  return Buffer.from(
    data,
    isJupyterBase64MimeType(type) ? "base64" : undefined,
  );
}

// Mutates data in place.  saveBlob stores the bytes and returns their sha1,
// or undefined if the blob store is unavailable (then data is left as is).
export function blobifyOutputData(
  data: { [type: string]: any },
  saveBlob: (bytes: Buffer, sha1: string, type: string) => string | undefined,
): void {
  for (const type of JUPYTER_MIMETYPES) {
    if (data[type] == null) {
      continue;
    }
    if (
      type.split("/")[0] !== "image" &&
      type !== "application/pdf" &&
      type !== "text/html"
    ) {
      continue;
    }
    if (isSha1(data[type])) {
      // already processed, e.g., a browser that was processing output closed
      // and the project took over.
      continue;
    }
    if (type == "text/html" && !shouldUseIframe(data[type])) {
      continue;
    }
    const bytes = outputBlobBytes(data[type], type);
    const s = saveBlob(bytes, sha1(bytes), type);
    if (s) {
      // only replace if the save worked -- don't break output for an
      // optimization.
      if (type == "text/html") {
        // may or may not be rendered as an iframe; the name is historical.
        data["iframe"] = s;
        delete data["text/html"];
      } else {
        data[type] = s;
      }
    }
  }
}
