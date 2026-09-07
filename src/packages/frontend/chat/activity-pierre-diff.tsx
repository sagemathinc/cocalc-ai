import { Alert } from "antd";
import { useMemo } from "react";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import { ReadOnlyDiff } from "@cocalc/frontend/components/diff-viewer/document-diff";
import { activityDiffSource } from "./activity-diff-source";

export default function ActivityPierreDiff({
  diff,
  path,
  fontSize,
}: {
  diff: LineDiffResult;
  path: string;
  fontSize: number;
}) {
  const parsed = useMemo(() => {
    try {
      return { source: activityDiffSource(diff, path), error: "" };
    } catch (error) {
      return { source: undefined, error: String(error) };
    }
  }, [diff, path]);
  if (!parsed.source)
    return (
      <Alert
        type="warning"
        title="Pierre cannot display this entry"
        description={parsed.error}
      />
    );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "min(60vh, 600px)",
        minHeight: 160,
        minWidth: 0,
      }}
    >
      <div role="note">
        Recorded activity only; omitted context is unavailable. File links open
        the current working copy, not this historical patch.
      </div>
      <ReadOnlyDiff source={parsed.source} fontSize={fontSize} />
    </div>
  );
}
