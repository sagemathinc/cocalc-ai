/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import PublicViewerSlidesRenderer from "./renderers/slides";
import { buildViewerFileContext } from "./viewer-file-context";
import { mountPublicViewer } from "./shared";

export function init(): void {
  mountPublicViewer(
    ({ config, content }): JSX.Element => (
      <PublicViewerSlidesRenderer
        content={content}
        fileContext={buildViewerFileContext({
          path: config.path,
          rawUrl: config.rawUrl,
        })}
      />
    ),
  );
}
