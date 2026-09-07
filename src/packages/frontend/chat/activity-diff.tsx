import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import { DiffRenderBoundary } from "@cocalc/frontend/components/diff-viewer/render-boundary";

const ActivityPierreDiff = lazy(() => import("./activity-pierre-diff"));

export function ActivityDiff({
  children,
  diff,
  path,
  fontSize,
}: {
  children: ReactNode;
  diff: LineDiffResult;
  path: string;
  fontSize: number;
}) {
  const [pierre, setPierre] = useState(false);
  if (!diff.source) return <>{children}</>;
  return (
    <>
      <label>
        Activity diff renderer{" "}
        <select
          value={pierre ? "pierre" : "classic"}
          onChange={(event) => setPierre(event.target.value === "pierre")}
        >
          <option value="classic">Classic</option>
          <option value="pierre">Pierre (experimental)</option>
        </select>
      </label>
      {pierre ? (
        <DiffRenderBoundary>
          <Suspense
            fallback={<div role="status">Loading activity diff...</div>}
          >
            <ActivityPierreDiff diff={diff} path={path} fontSize={fontSize} />
          </Suspense>
        </DiffRenderBoundary>
      ) : (
        children
      )}
    </>
  );
}
