/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lazy, Suspense, useState } from "react";
import { ClassicDiff } from "./classic-diff";
import type { TimeTravelDiffProps } from "./classic-diff";
import { DiffRenderBoundary } from "@cocalc/frontend/components/diff-viewer/render-boundary";

const DocumentDiff = lazy(
  () => import("@cocalc/frontend/components/diff-viewer/document-diff"),
);

export function Diff(props: TimeTravelDiffProps) {
  const [renderer, setRenderer] = useState("classic");
  return (
    <div
      className="smc-vfill"
      style={{ minHeight: 0, minWidth: 0, height: "100%", overflow: "hidden" }}
    >
      <label style={{ padding: 4, flexShrink: 0 }}>
        Text diff renderer{" "}
        <select
          value={renderer}
          onChange={(event) => setRenderer(event.target.value)}
        >
          <option value="classic">Classic</option>
          <option value="pierre">Pierre (experimental)</option>
        </select>
      </label>
      {renderer === "classic" ? (
        <ClassicDiff {...props} />
      ) : (
        <DiffRenderBoundary>
          <Suspense fallback={<div role="status">Loading text diff...</div>}>
            <DocumentDiff
              before={props.v0}
              after={props.v1}
              path={props.use_json ? "history.json" : props.path}
              label={`${props.path}: selected TimeTravel versions`}
              fontSize={props.font_size}
            />
          </Suspense>
        </DiffRenderBoundary>
      )}
    </div>
  );
}
