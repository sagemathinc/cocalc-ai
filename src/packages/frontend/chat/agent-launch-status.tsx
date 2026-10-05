import { useEffect, useState } from "react";
import { Alert, Button, Modal, Space } from "antd";
import { CodexCredentialsPanel } from "@cocalc/frontend/account/codex-credentials-panel";

interface LaunchReceipt {
  state: "pending" | "accepted" | "unknown" | "rejected";
  updated_at: number;
  error?: string;
  // Set when admission refused the turn because this agent cannot pay for it.
  needs?: "codex-connection" | "human-turn";
}

export function AgentLaunchStatus({
  receipt,
  acpState,
  onResubmit,
  projectId,
}: {
  receipt: LaunchReceipt | { toJS(): LaunchReceipt } | undefined;
  acpState?: string;
  onResubmit?: () => Promise<boolean>;
  projectId?: string;
}) {
  const launch = receipt && ("toJS" in receipt ? receipt.toJS() : receipt);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [connectOpen, setConnectOpen] = useState(false);
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
  const needs = launch.state === "rejected" ? launch.needs : undefined;
  return (
    <Alert
      type={pending ? "info" : "warning"}
      role="status"
      title={
        pending
          ? "Message saved; requesting agent launch"
          : needs === "codex-connection"
            ? "Message saved; this agent needs a ChatGPT plan or API key"
            : needs
              ? "Message saved; this agent has not been set up yet"
              : "Message saved; agent launch not confirmed"
      }
      description={
        <div>
          {needs === "codex-connection" ? (
            <p>
              Another agent sent this message, but nothing is connected to pay
              for this agent's turns. Connect a ChatGPT plan or OpenAI API key,
              then resubmit. The sending agent was told why.
            </p>
          ) : needs ? (
            <p>
              Another agent sent this message. Send this agent one message
              yourself so it has a confirmed payment method, then resubmit. The
              sending agent was told why.
            </p>
          ) : (
            !pending && (
              <p>
                {launch.error ??
                  "No launch acknowledgment was recorded. Check the recipient's activity before resubmitting; a missing acknowledgment does not prove the turn failed."}
              </p>
            )
          )}
          {!pending && !needs && (
            <p>
              A missing acknowledgment does not prove the turn failed.
              Resubmission checks the existing job first.
            </p>
          )}
          {needs === "codex-connection" && (
            <Space style={{ marginBottom: 8 }}>
              <Button type="primary" onClick={() => setConnectOpen(true)}>
                Connect
              </Button>
            </Space>
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
          {connectOpen && (
            <Modal
              open
              title="Connect a ChatGPT plan or OpenAI API key"
              footer={null}
              onCancel={() => setConnectOpen(false)}
              width={760}
              destroyOnHidden
            >
              <CodexCredentialsPanel embedded defaultProjectId={projectId} />
            </Modal>
          )}
        </div>
      }
    />
  );
}
