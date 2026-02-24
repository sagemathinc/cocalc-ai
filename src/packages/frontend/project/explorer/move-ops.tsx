import { Button, Popconfirm, Popover, Progress, Space, Spin, Tag, Timeline } from "antd";
import { useMemo, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  LRO_DISMISSABLE_STATUSES,
  LRO_TERMINAL_STATUSES,
  isDismissed,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import { User } from "@cocalc/frontend/users/user";

const HIDE_STATUSES = new Set<LroStatus>(["succeeded"]);
const MOVE_PHASES = [
  { key: "validate", label: "Validate move request" },
  { key: "stop-source", label: "Stop source workspace" },
  { key: "backup", label: "Prepare backup state" },
  { key: "placement", label: "Update workspace placement" },
  { key: "start-dest", label: "Start destination workspace" },
  { key: "cleanup", label: "Cleanup source host data" },
  { key: "done", label: "Move complete" },
] as const;

type MovePhaseKey = (typeof MOVE_PHASES)[number]["key"];

export default function MoveOps({ project_id }: { project_id: string }) {
  const { actions } = useProjectContext();
  const moveOp = useTypedRedux({ project_id }, "move_lro")?.toJS() as
    | MoveLroState
    | undefined;
  if (!moveOp) {
    return null;
  }
  const summary = moveOp.summary;
  if (summary && HIDE_STATUSES.has(summary.status)) {
    return null;
  }
  if (isDismissed(summary)) {
    return null;
  }
  const canDismiss =
    summary != null && LRO_DISMISSABLE_STATUSES.has(summary.status);
  const canCancel = summary != null && !LRO_TERMINAL_STATUSES.has(summary.status);
  const percent = progressPercent(moveOp);
  const statusText = formatStatusLine(moveOp);
  const progressStatus = progressBarStatus(summary?.status);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: "4px",
        padding: "6px 8px",
        marginBottom: "8px",
        background: "white",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "6px" }}>
        Move operation
      </div>
      <Space size="small" align="center">
        {percent == null ? (
          <Spin size="small" />
        ) : (
          <Progress
            percent={percent}
            status={progressStatus}
            size="small"
            style={{ width: "180px" }}
          />
        )}
        <span style={{ fontSize: "11px", color: "#666" }}>{statusText}</span>
        <Popover
          trigger="click"
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          content={<MoveOpDetails op={moveOp} />}
          placement="bottomLeft"
        >
          <Button size="small" type="link">
            Details
          </Button>
        </Popover>
        {canCancel ? (
          <Popconfirm
            title="Cancel this move operation?"
            okText="Cancel"
            cancelText="Keep"
            onConfirm={() =>
              webapp_client.conat_client.hub.lro.cancel({ op_id: moveOp.op_id })
            }
          >
            <Button size="small" type="link">
              Cancel
            </Button>
          </Popconfirm>
        ) : null}
        {canDismiss ? (
          <Button
            size="small"
            type="link"
            onClick={() => actions?.dismissMoveLro(moveOp.op_id)}
          >
            Dismiss
          </Button>
        ) : null}
      </Space>
    </div>
  );
}

function MoveOpDetails({ op }: { op: MoveLroState }) {
  const summary = op.summary;
  const [copied, setCopied] = useState<boolean>(false);
  const phase = phaseFromOp(op);
  const activeIndex = phaseIndex(phase);
  const status = summary?.status;
  const statusText = formatStatusLine(op);

  const timelineItems = useMemo(() => {
    return MOVE_PHASES.map((entry, index) => ({
      color: phaseColor({ index, activeIndex, status }),
      children: <span>{entry.label}</span>,
    }));
  }, [activeIndex, status]);

  return (
    <div style={{ width: "460px", maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div style={{ fontWeight: 600 }}>Move operation lifecycle</div>
        <Space wrap size={[6, 6]}>
          <Tag color={statusColor(status)}>{status ?? "running"}</Tag>
          <Tag>
            Operation ID: <code>{op.op_id}</code>
          </Tag>
          <Button
            size="small"
            type="link"
            onClick={async () => {
              await navigator.clipboard.writeText(op.op_id);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : "Copy ID"}
          </Button>
        </Space>
        <div style={{ fontSize: "12px", color: "#666" }}>{statusText}</div>
        <Space size="small" wrap style={{ fontSize: "12px" }}>
          {summary?.created_by ? (
            <span>
              Initiated by{" "}
              <User account_id={summary.created_by} show_avatar avatarSize={16} />
            </span>
          ) : null}
          {summary?.created_at ? (
            <span>
              Started <TimeAgo date={summary.created_at} />
            </span>
          ) : null}
          {summary?.updated_at ? (
            <span>
              Updated <TimeAgo date={summary.updated_at} />
            </span>
          ) : null}
        </Space>
        <Timeline items={timelineItems} />
      </Space>
    </div>
  );
}

function formatStatusLine(op: MoveLroState): string {
  const summary = op.summary;
  if (summary?.status === "failed") {
    return summary.error ? `failed: ${summary.error}` : "failed";
  }
  if (summary?.status === "canceled") {
    return "canceled";
  }
  if (summary?.status === "expired") {
    return "expired";
  }
  const phase = summary?.progress_summary?.phase;
  if (phase) {
    return phase;
  }
  const progress = op.last_progress;
  const message = progress?.phase ?? progress?.message;
  if (message) {
    return message;
  }
  return summary?.status ?? "running";
}

function progressPercent(op: MoveLroState): number | undefined {
  const progress = op.last_progress?.progress;
  if (progress != null) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }
  return undefined;
}

function phaseFromOp(op: MoveLroState): MovePhaseKey | undefined {
  const value =
    op.last_progress?.phase ??
    op.summary?.progress_summary?.phase ??
    op.last_progress?.message;
  if (typeof value !== "string") return;
  const lower = value.trim().toLowerCase();
  if (!lower) return;
  if (lower.includes("validate")) return "validate";
  if (lower.includes("stop source")) return "stop-source";
  if (lower.includes("backup")) return "backup";
  if (lower.includes("placement")) return "placement";
  if (lower.includes("start")) return "start-dest";
  if (lower.includes("cleanup")) return "cleanup";
  if (lower.includes("done") || lower.includes("complete")) return "done";
  return;
}

function phaseIndex(phase: MovePhaseKey | undefined): number {
  if (!phase) return 0;
  const idx = MOVE_PHASES.findIndex((entry) => entry.key === phase);
  return idx < 0 ? 0 : idx;
}

function statusColor(status?: string): string {
  if (status === "succeeded") return "green";
  if (status === "failed") return "red";
  if (status === "canceled") return "orange";
  if (status === "expired") return "red";
  return "processing";
}

function phaseColor({
  index,
  activeIndex,
  status,
}: {
  index: number;
  activeIndex: number;
  status?: string;
}): string {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "expired") {
    if (index < activeIndex) return "green";
    if (index === activeIndex) return "red";
    return "gray";
  }
  if (status === "canceled") {
    if (index < activeIndex) return "green";
    if (index === activeIndex) return "orange";
    return "gray";
  }
  if (index < activeIndex) return "green";
  if (index === activeIndex) return "blue";
  return "gray";
}
