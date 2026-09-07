/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lazy, Suspense } from "react";
import type { AccountState } from "@cocalc/frontend/account/types";
import { DiffRenderBoundary } from "@cocalc/frontend/components/diff-viewer/render-boundary";

const DocumentDiff = lazy(
  () => import("@cocalc/frontend/components/diff-viewer/document-diff"),
);

export interface TimeTravelDiffProps {
  v0: string;
  v1: string;
  path: string;
  editor_settings: AccountState["editor_settings"];
  font_size: number;
  use_json: boolean;
}

export function Diff(props: TimeTravelDiffProps) {
  return (
    <div
      className="smc-vfill"
      style={{ minHeight: 0, minWidth: 0, height: "100%", overflow: "hidden" }}
    >
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
    </div>
  );
}
