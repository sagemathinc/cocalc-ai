/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { lazy, Suspense, useState } from "react";
import type { MutableRefObject } from "react";
import { GitDiffFilesPanel } from "./drawer-sections";
import type { GitDiffFilesPanelProps } from "./drawer-sections";

const PierreReviewPanel = lazy(() => import("./pierre-review-panel"));

export interface ReviewDiffNavigation {
  navigateToFile(index: number): void;
  viewport(): HTMLElement | null;
}

export type ReviewDiffPanelProps = GitDiffFilesPanelProps & {
  navigationRef: MutableRefObject<ReviewDiffNavigation | null>;
  onActiveFile: (index: number) => void;
  linesTruncated: boolean;
  repoRoot?: string;
  activeDraft?: import("./types").CommentAnchor;
};

export function ReviewDiffPanel(props: ReviewDiffPanelProps) {
  const [renderer, setRenderer] = useState("legacy");
  return (
    <>
      <label>
        Diff renderer{" "}
        <select
          aria-label="Diff renderer"
          value={renderer}
          disabled={Boolean(props.activeDraft || props.activeEditingId)}
          onChange={(event) => setRenderer(event.target.value)}
        >
          <option value="legacy">Classic</option>
          <option value="pierre">Pierre (experimental)</option>
        </select>
      </label>
      {renderer === "pierre" ? (
        <Suspense fallback={<div role="status">Loading diff renderer...</div>}>
          <PierreReviewPanel {...props} />
        </Suspense>
      ) : (
        <GitDiffFilesPanel {...props} />
      )}
    </>
  );
}
