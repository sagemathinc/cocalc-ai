/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { lazy, Suspense } from "react";
import type { MutableRefObject } from "react";
import type { GitDiffFilesPanelProps } from "./drawer-sections";
import type { DiffScrollAnchor } from "@cocalc/frontend/components/diff-viewer/review-model";
import { useWorkingScrollGeneration } from "./working-scroll-generation";

const PierreReviewPanel = lazy(() => import("./pierre-review-panel"));

export interface ReviewDiffNavigation {
  handlesSearch?: boolean;
  navigateToFile(index: number, behavior?: "auto" | "smooth"): void;
  viewport(): HTMLElement | null;
}

export type ReviewDiffPanelProps = GitDiffFilesPanelProps & {
  navigationRef: MutableRefObject<ReviewDiffNavigation | null>;
  onActiveFile: (index: number) => void;
  linesTruncated: boolean;
  repoRoot?: string;
  canOpenWorkingCopy?: boolean;
  activeDraft?: import("./types").CommentAnchor;
  firstParentProvenance?: boolean;
  commentingDisabled?: boolean;
  scrollScope?: string;
  initialScrollAnchor?: DiffScrollAnchor;
  onClaimScrollRestoration?: () => void;
  workingScrollGeneration?: string;
};

export function ReviewDiffPanel(props: ReviewDiffPanelProps) {
  const generation = useWorkingScrollGeneration(
    props.files,
    props.linesTruncated,
    props.isHeadSelected && !!props.scrollScope,
  );
  const scope = props.isHeadSelected
    ? generation && props.scrollScope
      ? JSON.stringify([props.scrollScope, "loaded-working-patch", generation])
      : undefined
    : props.scrollScope;
  return (
    <Suspense fallback={<div role="status">Loading diff renderer...</div>}>
      <PierreReviewPanel
        {...props}
        scrollScope={scope}
        workingScrollGeneration={generation}
      />
    </Suspense>
  );
}
