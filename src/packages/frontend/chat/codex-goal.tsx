import { useId, useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type {
  CodexGoalAck,
  CodexGoalCommand,
  CodexGoalSnapshot,
} from "@cocalc/util/ai/codex-goal";

export function CodexGoalControl({
  snapshot,
  request,
  ack,
  onChange,
}: {
  snapshot?: CodexGoalSnapshot;
  request?: CodexGoalCommand;
  ack?: CodexGoalAck;
  onChange: (
    change: Omit<CodexGoalCommand, "id" | "sessionId">,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending =
    request != null && (request.id !== ack?.id || ack?.state === "applying");
  const goal = snapshot?.goal;
  const commandError = ack?.id === request?.id ? ack?.error : undefined;
  const label =
    pending && request?.action === "clear"
      ? "No goal"
      : ((pending ? request?.objective : undefined) ?? goal?.objective);
  const status = pending
    ? ack?.id === request?.id
      ? "awaiting confirmation"
      : "pending"
    : ack?.error && ack.id === request?.id
      ? "change failed"
      : goal?.status?.replaceAll("_", " ");
  const show = () => {
    setObjective(
      (commandError ? request?.objective : undefined) ?? label ?? "",
    );
    const value =
      (pending || commandError) && request?.tokenBudget !== undefined
        ? request.tokenBudget
        : goal?.tokenBudget;
    setBudget(value == null ? "" : String(value));
    setError("");
    setOpen(true);
  };
  const apply = async (change: Omit<CodexGoalCommand, "id" | "sessionId">) => {
    setBusy(true);
    setError("");
    try {
      await onChange(change);
      setOpen(false);
    } catch (err) {
      if (!open) show();
      setError(String(err));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div
        style={{ display: "flex", alignItems: "center", minWidth: 0, gap: 4 }}
      >
        <button
          type="button"
          onClick={show}
          title={label ?? "Set goal"}
          aria-label={
            label
              ? `Goal: ${label}${status ? ` (${status})` : ""}`
              : `Set goal${status ? ` (${status})` : ""}`
          }
          style={{
            background: "none",
            border: 0,
            padding: 0,
            color: UI_COLORS.text,
            cursor: "pointer",
            minWidth: 0,
            display: "flex",
            alignItems: "baseline",
            gap: 4,
            fontSize: 12,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label ? `Goal: ${label}` : "Set goal"}
          </span>
          {status && (
            <span style={{ flexShrink: 0, color: UI_COLORS.secondary }}>
              ({status})
            </span>
          )}
        </button>
        {goal && goal.status !== "complete" && !pending && (
          <Button
            type="text"
            size="small"
            disabled={busy}
            onClick={() =>
              void apply({
                action: "set",
                status: goal.status === "active" ? "paused" : "active",
              })
            }
          >
            {goal.status === "active" ? "Pause" : "Resume"}
          </Button>
        )}
      </div>
      <Modal
        title="Goal"
        open={open}
        onCancel={() => !busy && setOpen(false)}
        destroyOnHidden
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
        footer={
          <div
            style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
          >
            <Button
              danger
              disabled={busy || (!goal && !pending)}
              onClick={() => void apply({ action: "clear" })}
            >
              Clear goal
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!objective.trim()}
              onClick={() => {
                const tokenBudget = budget.trim() ? Number(budget) : null;
                if (
                  tokenBudget !== null &&
                  (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
                ) {
                  setError("Token budget must be a positive integer");
                  return;
                }
                void apply({
                  action: "set",
                  objective: objective.trim(),
                  tokenBudget,
                  ...(!goal || goal.status === "complete"
                    ? { status: "active" as const }
                    : {}),
                });
              }}
            >
              Save goal
            </Button>
          </div>
        }
      >
        <KeyboardBoundary>
          {(error || commandError) && (
            <Alert
              type="error"
              title={error || commandError}
              style={{ marginBottom: 8 }}
            />
          )}
          <label htmlFor={`${id}-objective`}>
            What should Codex accomplish?
          </label>
          <Input.TextArea
            id={`${id}-objective`}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 10 }}
            maxLength={100000}
          />
          <details style={{ marginTop: 12 }}>
            <summary>Budget and usage</summary>
            <label htmlFor={`${id}-budget`}>Token budget (optional)</label>
            <Input
              id={`${id}-budget`}
              inputMode="numeric"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="No token budget"
            />
            {goal && (
              <p>
                {goal.tokensUsed.toLocaleString()} tokens used ·{" "}
                {Math.round(goal.timeUsedSeconds / 60)} min
              </p>
            )}
          </details>
          <p style={{ color: UI_COLORS.secondary, marginTop: 12 }}>
            Changes apply to the running turn, or when the next turn starts.
            Pause prevents automatic continuation; Stop also interrupts the
            current turn. Viewing this goal does not start Codex.
          </p>
        </KeyboardBoundary>
      </Modal>
    </>
  );
}
