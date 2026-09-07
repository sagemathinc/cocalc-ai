/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { GitDiffFilesPanel } from "./drawer-sections";
import type { GitDiffFilesPanelProps } from "./drawer-sections";
import type { DiffScrollAnchor } from "@cocalc/frontend/components/diff-viewer/review-model";
import { capturePierreScrollAnchor } from "@cocalc/frontend/components/diff-viewer/scroll-anchor";
import { reviewFileHeaderHeight } from "@cocalc/frontend/components/diff-viewer/review-file-header";
import { buildLegacyFileLocations } from "./legacy-locations";
import {
  captureClassicScrollAnchor,
  classicScrollTarget,
} from "./renderer-scroll";
import { buildGitReviewFileSectionId } from "./ids";
import { getRenderedDiffLineLimit } from "./diff-find";

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
  firstParentProvenance?: boolean;
  commentingDisabled?: boolean;
  scrollScope?: string;
  initialScrollAnchor?: DiffScrollAnchor;
};

export function ReviewDiffPanel(props: ReviewDiffPanelProps) {
  const [renderer, setRenderer] = useState("legacy");
  const [handoff, setHandoff] = useState<DiffScrollAnchor>();
  const pending = useRef(false);
  const locations = useMemo(
    () => buildLegacyFileLocations(props.files),
    [props.files],
  );
  useEffect(() => {
    if (renderer !== "legacy" || !pending.current || !handoff) return;
    if (
      handoff.location.targetId !== props.scrollScope ||
      props.activeDiffFindMatch
    ) {
      pending.current = false;
      return;
    }
    const target = classicScrollTarget(locations, handoff);
    const viewport = props.drawerScrollParent;
    if (!target || !viewport) {
      pending.current = false;
      return;
    }
    const sectionId = buildGitReviewFileSectionId(
      props.files[target.fileIndex].path,
      target.fileIndex,
    );
    if (
      target.rowIndex >=
      getRenderedDiffLineLimit(props.visibleDiffLinesByFile[sectionId])
    ) {
      props.onShowMoreLines(sectionId);
      return;
    }
    props.virtuosoRef.current?.scrollToIndex({
      index: target.fileIndex,
      align: "start",
      behavior: "auto",
    });
    let frame: number;
    let attempts = 0;
    const restore = () => {
      if (!pending.current) return;
      const row = viewport.querySelector<HTMLElement>(`#${target.elementId}`);
      if (row && row.getBoundingClientRect().height > 0) {
        const header = row
          .closest("[data-git-diff-section]")
          ?.querySelector("[data-review-file-id]");
        const headerHeight = header
          ? Math.max(
              0,
              header.getBoundingClientRect().height +
                Math.min(0, parseFloat(getComputedStyle(header).top) || 0),
            )
          : 0;
        viewport.scrollTop +=
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          headerHeight -
          handoff.offset;
        pending.current = false;
      } else if (++attempts < 120) frame = requestAnimationFrame(restore);
      else pending.current = false;
    };
    const cancel = () => {
      pending.current = false;
      cancelAnimationFrame(frame);
    };
    for (const event of ["wheel", "pointerdown", "keydown"])
      viewport.addEventListener(event, cancel);
    frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      for (const event of ["wheel", "pointerdown", "keydown"])
        viewport.removeEventListener(event, cancel);
    };
  }, [renderer, handoff, locations, props]);
  const switchRenderer = (next: string) => {
    const scope = props.scrollScope;
    const viewport =
      renderer === "pierre"
        ? props.navigationRef.current?.viewport()
        : props.drawerScrollParent;
    const anchor =
      scope && viewport
        ? renderer === "pierre"
          ? capturePierreScrollAnchor(
              viewport,
              scope,
              reviewFileHeaderHeight(props.fontSize),
            )
          : captureClassicScrollAnchor(viewport, scope, locations)
        : undefined;
    setHandoff(anchor);
    pending.current = !!anchor;
    setRenderer(next);
  };
  return (
    <>
      <label>
        Diff renderer{" "}
        <select
          aria-label="Diff renderer"
          value={renderer}
          disabled={Boolean(props.activeDraft || props.activeEditingId)}
          onChange={(event) => switchRenderer(event.target.value)}
        >
          <option value="legacy">Classic</option>
          <option value="pierre">Pierre (experimental)</option>
        </select>
      </label>
      {renderer === "pierre" ? (
        <Suspense fallback={<div role="status">Loading diff renderer...</div>}>
          <PierreReviewPanel {...props} initialScrollAnchor={handoff} />
        </Suspense>
      ) : (
        <GitDiffFilesPanel {...props} />
      )}
    </>
  );
}
