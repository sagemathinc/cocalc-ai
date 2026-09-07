import { Alert, Button } from "antd";
import { useId, useMemo, useState } from "react";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import { ReadOnlyDiff } from "@cocalc/frontend/components/diff-viewer/document-diff";
import { activityDiffSource } from "./activity-diff-source";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export default function ActivityPierreDiff({
  diff,
  path,
  fontSize,
}: {
  diff: LineDiffResult;
  path: string;
  fontSize: number;
}) {
  const [showRecordedData, setShowRecordedData] = useState(false);
  const recordedDataId = useId();
  const parsed = useMemo(() => {
    try {
      return { source: activityDiffSource(diff, path), error: "" };
    } catch (error) {
      return { source: undefined, error: String(error) };
    }
  }, [diff, path]);
  if (!parsed.source)
    return (
      <div>
        <Alert
          type="warning"
          title="A reliable diff is unavailable for this activity entry"
          description={parsed.error}
        />
        <Button
          type="link"
          aria-expanded={showRecordedData}
          aria-controls={recordedDataId}
          onClick={() => setShowRecordedData((show) => !show)}
        >
          Recorded diff data
        </Button>
        <div id={recordedDataId} hidden={!showRecordedData}>
          {showRecordedData && (
            <pre
              style={{
                maxHeight: "60vh",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                color: UI_COLORS.text,
                background: UI_COLORS.inset,
                fontSize,
              }}
            >
              {JSON.stringify(diff, null, 2)}
            </pre>
          )}
        </div>
      </div>
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
        {diff.source?.kind === "observed-documents"
          ? "Recorded read/write observations, not an atomic filesystem snapshot. "
          : "Recorded activity only; omitted context is unavailable. "}
        File links open the current working copy, not this historical content.
      </div>
      <ReadOnlyDiff source={parsed.source} fontSize={fontSize} />
    </div>
  );
}
