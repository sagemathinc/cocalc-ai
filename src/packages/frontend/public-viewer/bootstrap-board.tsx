/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, lazy } from "react";
import type { JSX } from "react";
import { buildViewerFileContext } from "./viewer-file-context";
import { mountPublicViewer } from "./shared";

const PublicViewerBoardRenderer = lazy(() => import("./renderers/board"));

export function init(): void {
  mountPublicViewer(
    ({ config, content }): JSX.Element => (
      <Suspense fallback={<LoadingRenderer />}>
        <PublicViewerBoardRenderer
          content={content}
          fileContext={buildViewerFileContext({
            path: config.path,
            rawUrl: config.rawUrl,
          })}
        />
      </Suspense>
    ),
  );
}

function LoadingRenderer(): JSX.Element {
  return <div style={{ color: "#666" }}>Loading board viewer...</div>;
}
