import { lazy, Suspense } from "react";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import { DiffRenderBoundary } from "@cocalc/frontend/components/diff-viewer/render-boundary";

const ActivityPierreDiff = lazy(() => import("./activity-pierre-diff"));

export function ActivityDiff({
  diff,
  path,
  fontSize,
}: {
  diff: LineDiffResult;
  path: string;
  fontSize: number;
}) {
  return (
    <DiffRenderBoundary>
      <Suspense fallback={<div role="status">Loading activity diff...</div>}>
        <ActivityPierreDiff diff={diff} path={path} fontSize={fontSize} />
      </Suspense>
    </DiffRenderBoundary>
  );
}
