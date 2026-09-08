import { Alert, Button, Radio, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { GitReviewAliasConflict } from "../git-review-store";

export function ReviewAliasChoice({
  conflict,
  onChoose,
  onReload,
}: {
  conflict: GitReviewAliasConflict;
  onChoose: (selected: string) => Promise<void>;
  onReload: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Alert
      type="warning"
      title="Multiple saved reviews refer to this commit"
      description={
        <>
          <p>
            Choose which review to continue editing. Other records and drafts
            are retained unchanged, not merged or deleted. If another record
            changes, you will be asked again.
          </p>
          <Radio.Group
            aria-label="Active saved review"
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
          >
            {conflict.inspection.records.map((record) => (
              <div key={record.commit_sha}>
                <Radio value={record.commit_sha}>
                  Use review {record.commit_sha}
                </Radio>
                <details>
                  <summary>
                    {record.reviewed ? "Reviewed" : "Not reviewed"};{" "}
                    {Object.keys(record.comments).length} comments; inspect
                    saved content
                  </summary>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      maxHeight: 320,
                      overflow: "auto",
                    }}
                  >
                    {JSON.stringify(record, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </Radio.Group>
          {error && <div role="alert">{error}</div>}
          <Space>
            <Button
              disabled={!selected || busy}
              loading={busy}
              onClick={async () => {
                if (!selected || busy) return;
                setBusy(true);
                setError("");
                try {
                  await onChoose(selected);
                } catch (error) {
                  if (mounted.current) setError(String(error));
                } finally {
                  if (mounted.current) setBusy(false);
                }
              }}
            >
              Use selected review
            </Button>
            <Button disabled={busy} onClick={onReload}>
              Reload reviews
            </Button>
          </Space>
        </>
      }
    />
  );
}
