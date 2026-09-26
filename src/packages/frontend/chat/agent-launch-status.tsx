import { useEffect, useState } from "react";
import { Alert, Button } from "antd";

interface LaunchReceipt {
  state: "pending" | "accepted" | "unknown" | "rejected";
  updated_at: number;
  error?: string;
}

export function AgentLaunchStatus({
  receipt,
  acpState,
  onResubmit,
}: {
  receipt: LaunchReceipt | { toJS(): LaunchReceipt } | undefined;
  acpState?: string;
  onResubmit?: () => Promise<boolean>;
}) {
  const launch = receipt && ("toJS" in receipt ? receipt.toJS() : receipt);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  useEffect(() => {
    if (launch?.state !== "pending") return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, launch.updated_at + 30_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [launch?.state, launch?.updated_at]);
  if (!launch || launch.state === "accepted") return null;
  // The normal job projection is stronger evidence than a missing RPC receipt.
  if (
    acpState &&
    ["queue", "running", "done", "sending", "sent"].includes(acpState)
  )
    return null;
  const pending =
    launch.state === "pending" && now < launch.updated_at + 30_000;
  return (
    <Alert
      type={pending ? "info" : "warning"}
      role="status"
      title={
        pending
          ? "Message saved; requesting agent launch"
          : "Message saved; agent launch not confirmed"
      }
      description={
        <div>
          {!pending && (
            <p>
              {launch.error ??
                "No launch acknowledgment was recorded. Check the recipient's activity before resubmitting; a missing acknowledgment does not prove the turn failed."}
            </p>
          )}
          {!pending && (
            <p>
              A missing acknowledgment does not prove the turn failed.
              Resubmission checks the existing job first.
            </p>
          )}
          {!pending && onResubmit && (
            <Button
              loading={busy}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setResult(undefined);
                try {
                  const ok = await onResubmit();
                  setResult(
                    ok
                      ? "Submission confirmed."
                      : "Submission not confirmed. Check the agent's activity and AI settings.",
                  );
                } catch {
                  setResult(
                    "Submission not confirmed. Check the agent's activity before retrying.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Resubmit to Agent
            </Button>
          )}
          {result && <p>{result}</p>}
        </div>
      }
    />
  );
}
