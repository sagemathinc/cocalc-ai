/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Document } from "@cocalc/sync/editor/generic/types";
import json_stable from "json-stable-stringify";
import { to_ipynb } from "../../jupyter/history-viewer";

export interface TimeTravelDocumentSource {
  text: string;
  useJson: boolean;
}

export function timeTravelDocumentSource(
  doc: Document | undefined,
  ext?: string,
): TimeTravelDocumentSource {
  if (doc == null) {
    return { text: "unknown version", useJson: false };
  }
  if (ext?.toLowerCase() === "ipynb") {
    try {
      return {
        text: json_stable(to_ipynb(doc), { space: 1 }) ?? "",
        useJson: true,
      };
    } catch (_err) {
      // Do not let an unexpected legacy notebook shape blank source/diff views.
      return { text: doc.to_str(), useJson: true };
    }
  }
  return { text: doc.to_str(), useJson: (doc as any)["value"] == null };
}
