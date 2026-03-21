import { Progress, Space, Tag } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  LRO_TERMINAL_STATUSES,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { RootfsPublishLroState } from "@cocalc/frontend/project/rootfs-publish-ops";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";

const PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  validate: "Validate",
  snapshot: "Snapshot",
  publish: "Publish",
  catalog: "Catalog",
  done: "Done",
};

export default function RootfsPublishOps({
  project_id,
}: {
  project_id: string;
}) {
  const publishOps =
    useTypedRedux({ project_id }, "rootfs_publish_ops")?.toJS() ?? {};
  const entries = Object.values(publishOps) as RootfsPublishLroState[];
  const visible = entries.filter((op) => {
    if (!op.summary) return true;
    return !(
      op.summary.status === "succeeded" && op.summary.dismissed_at != null
    );
  });
  if (!visible.length) {
    return null;
  }
  visible.sort((a, b) => updatedAt(b) - updatedAt(a));

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
        RootFS publish operations
      </div>
      {visible.map((op) => (
        <RootfsPublishRow key={op.op_id} op={op} />
      ))}
    </div>
  );
}

function RootfsPublishRow({ op }: { op: RootfsPublishLroState }) {
  const percent = progressPercent(op);
  const status = op.summary?.status;
  const phase = phaseLabel(op);
  const message = op.last_progress?.message ?? statusLabel(status);
  const progressStatus = progressBarStatus(status);
  const resultImage = `${op.summary?.result?.image ?? ""}`.trim();

  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ fontSize: "12px", marginBottom: "2px" }}>
        Publish current project RootFS state
      </div>
      <Space size="small" align="center" wrap>
        <Progress
          percent={percent}
          status={progressStatus}
          size="small"
          style={{ width: "180px" }}
        />
        <span style={{ fontSize: "11px", color: "#666" }}>
          {phase}
          {message ? `: ${message}` : ""}
        </span>
        {status ? <Tag color={statusColor(status)}>{status}</Tag> : null}
        {resultImage ? (
          <Tag color="blue" style={{ maxWidth: "240px" }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden" }}>
              {resultImage}
            </span>
          </Tag>
        ) : null}
        {op.summary?.updated_at ? (
          <span style={{ fontSize: "11px", color: "#999" }}>
            <TimeAgo date={op.summary.updated_at} />
          </span>
        ) : null}
      </Space>
    </div>
  );
}

function progressPercent(op: RootfsPublishLroState): number {
  const progress = Number(op.last_progress?.progress);
  if (Number.isFinite(progress)) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }
  const status = op.summary?.status;
  if (status === "succeeded") return 100;
  if (LRO_TERMINAL_STATUSES.has(status ?? "queued")) return 100;
  return 0;
}

function phaseLabel(op: RootfsPublishLroState): string {
  const phase =
    `${op.last_progress?.phase ?? op.summary?.progress_summary?.phase ?? ""}`
      .trim()
      .toLowerCase() || "queued";
  return PHASE_LABELS[phase] ?? phase;
}

function updatedAt(op: RootfsPublishLroState): number {
  const date =
    op.summary?.updated_at ?? op.summary?.started_at ?? op.summary?.created_at;
  const ts = new Date(date as any).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function statusLabel(status?: LroStatus): string {
  switch (status) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    case "succeeded":
      return "complete";
    case "running":
      return "running";
    default:
      return "waiting for worker";
  }
}

function statusColor(status: LroStatus): string {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
    case "canceled":
    case "expired":
      return "red";
    default:
      return "blue";
  }
}
