/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import PublicViewerIpynbRenderer from "./renderers/ipynb";
import { buildViewerFileContext } from "./viewer-file-context";
import { mountPublicViewer } from "./shared";

export function init(): void {
  mountPublicViewer(
    ({ config, content }): JSX.Element => (
      <PublicViewerIpynbRenderer
        content={content}
        fileContext={buildViewerFileContext({
          path: config.path,
          rawUrl: config.rawUrl,
        })}
        style={{
          background: "#fff",
          padding: "24px",
          borderRadius: "12px",
          boxShadow: "0 1px 4px rgba(15, 23, 42, 0.08)",
        }}
      />
    ),
  );
}
