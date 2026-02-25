import { Button, Popconfirm, Popover, Progress, Space, Spin, Tag, Timeline } from "antd";
import { useMemo, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { plural } from "@cocalc/util/misc";
import {
  LRO_TERMINAL_STATUSES,
  isDismissed,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { CopyLroState } from "@cocalc/frontend/project/copy-ops";
import { TimeAgo } from "@cocalc/frontend/components";
import { User } from "@cocalc/frontend/users/user";
import {
  clampProgressPercent,
  formatProgressDetail,
  lroPhaseColor,
  lroStatusColor,
  lroUpdatedAt,
} from "./lro-timeline-utils";

const COPY_PHASES = [
  {
    key: "queued",
    label: "Queued",
    description: "Operation accepted and waiting for worker",
  },
  {
    key: "validate",
    label: "Validate",
    description: "Validate source, destinations, and permissions",
  },
  {
    key: "backup",
    label: "Create backup",
    description: "Create source snapshot backup when cross-host copy is required",
  },
  {
    key: "queue",
    label: "Queue remote copies",
    description: "Queue remote copy jobs on destination host(s)",
  },
  {
    key: "copy-local",
    label: "Copy local paths",
    description: "Execute same-host copies directly",
  },
  {
    key: "done",
    label: "Complete",
    description: "Operation completed and final summary persisted",
  },
] as const;

type CopyPhaseKey = (typeof COPY_PHASES)[number]["key"];

const COPY_PHASE_SET = new Set<CopyPhaseKey>(
  COPY_PHASES.map((phase) => phase.key),
);

export default function CopyOps({ project_id }: { project_id: string }) {
  const copyOps = useTypedRedux({ project_id }, "copy_ops")?.toJS() ?? {};
  const entries = Object.values(copyOps) as CopyLroState[];
  const active = entries.filter(
    (op) =>
      !op.summary ||
      (!LRO_TERMINAL_STATUSES.has(op.summary.status) &&
        !isDismissed(op.summary)),
  );
  if (!active.length) {
    return null;
  }
  active.sort((a, b) => getUpdatedAt(b) - getUpdatedAt(a));

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
        Copy operations
      </div>
      {active.map((op) => (
        <CopyOpRow key={op.op_id} op={op} />
      ))}
    </div>
  );
}

function CopyOpRow({ op }: { op: CopyLroState }) {
  const summary = op.summary;
  const title = formatTitle(summary);
  const percent = progressPercent(op);
  const lastDetailRef = useRef<string | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const progress = op.last_progress;
  const detail = formatProgressDetail(progress?.detail);
  if (detail) {
    lastDetailRef.current = detail;
  }
  const statusText = formatStatusLine(op, detail ?? lastDetailRef.current);
  const progressStatus = progressBarStatus(summary?.status);
  const canCancel = summary && !LRO_TERMINAL_STATUSES.has(summary.status);

  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ fontSize: "12px", marginBottom: "2px" }}>{title}</div>
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
          content={<CopyOpTimeline op={op} />}
          placement="bottomLeft"
        >
          <Button type="link" size="small">
            Timeline
          </Button>
        </Popover>
        {canCancel && (
          <Popconfirm
            title="Cancel this copy operation?"
            okText="Cancel"
            cancelText="Keep"
            onConfirm={() =>
              webapp_client.conat_client.hub.lro.cancel({ op_id: op.op_id })
            }
          >
            <Button type="link" size="small">
              Cancel
            </Button>
          </Popconfirm>
        )}
      </Space>
    </div>
  );
}

function formatTitle(summary?: LroSummary): string {
  const src = summary?.input?.src?.path;
  const dests = summary?.input?.dests;
  const pathCount = Array.isArray(src) ? src.length : src ? 1 : 0;
  const destCount = Array.isArray(dests) ? dests.length : dests ? 1 : 0;
  if (pathCount && destCount) {
    return `Copy ${pathCount} ${plural(pathCount, "path")} to ${destCount} ${plural(
      destCount,
      "project",
    )}`;
  }
  if (pathCount) {
    return `Copy ${pathCount} ${plural(pathCount, "path")}`;
  }
  return "Copy operation";
}

function CopyOpTimeline({ op }: { op: CopyLroState }) {
  const summary = op.summary;
  const counts = summary?.progress_summary ?? {};
  const phaseKey = phaseFromOp(op);
  const activeIndex = phaseKey != null ? phaseIndex(phaseKey) : 0;
  const status = summary?.status;
  const statusText = formatStatusLine(op);
  const summaryCounts = formatCounts(counts);
  const detailText = formatProgressDetail(op.last_progress?.detail);
  const createdBy = summary?.created_by;
  const sourcePath = summary?.input?.src?.path;
  const sourceCount = Array.isArray(sourcePath)
    ? sourcePath.length
    : sourcePath
      ? 1
      : 0;
  const destCount = Array.isArray(summary?.input?.dests)
    ? summary?.input?.dests.length
    : summary?.input?.dest
      ? 1
      : 0;

  const timelineItems = useMemo(() => {
    return COPY_PHASES.map((phase, index) => ({
      color: phaseColor({
        index,
        activeIndex,
        status,
      }),
      children: (
        <div>
          <div style={{ fontWeight: 600 }}>{phase.label}</div>
          <div style={{ color: "#666", fontSize: "11px" }}>{phase.description}</div>
        </div>
      ),
    }));
  }, [activeIndex, status]);

  return (
    <div style={{ width: "460px", maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div style={{ fontWeight: 600 }}>Copy operation lifecycle</div>
        <Space wrap size={[6, 6]}>
          <Tag color={lroStatusColor(status)}>{status ?? "running"}</Tag>
          {summaryCounts ? <Tag>{summaryCounts}</Tag> : null}
          {detailText ? <Tag>{detailText}</Tag> : null}
        </Space>
        <div style={{ fontSize: "12px", color: "#666" }}>{statusText}</div>
        <Space size="small" wrap style={{ fontSize: "12px" }}>
          {createdBy ? (
            <span>
              Initiated by <User account_id={createdBy} show_avatar avatarSize={16} />
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
        <div style={{ fontSize: "12px" }}>
          {sourceCount > 0 ? (
            <span>
              {sourceCount} {plural(sourceCount, "source path")} to {destCount || 0}{" "}
              {plural(destCount || 0, "destination")}
            </span>
          ) : (
            <span>Source and destination metadata not available.</span>
          )}
        </div>
        <Timeline items={timelineItems} />
      </Space>
    </div>
  );
}

function phaseFromOp(op: CopyLroState): CopyPhaseKey | undefined {
  const phaseRaw =
    op.last_progress?.phase ??
    op.summary?.progress_summary?.phase ??
    op.last_progress?.message;
  if (typeof phaseRaw !== "string" || !phaseRaw.trim()) return;
  const lower = phaseRaw.trim().toLowerCase();
  if (COPY_PHASE_SET.has(lower as CopyPhaseKey)) {
    return lower as CopyPhaseKey;
  }
  if (lower.includes("queue")) return "queue";
  if (lower.includes("backup")) return "backup";
  if (lower.includes("local")) return "copy-local";
  if (lower.includes("validate")) return "validate";
  if (lower.includes("done") || lower.includes("complete")) return "done";
  return;
}

function phaseIndex(phase: CopyPhaseKey): number {
  const idx = COPY_PHASES.findIndex((entry) => entry.key === phase);
  return idx < 0 ? 0 : idx;
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
  return lroPhaseColor({ index, activeIndex, status });
}

function formatStatusLine(op: CopyLroState, detailOverride?: string): string {
  const summary = op.summary;
  const progress = op.last_progress;
  const message =
    summary?.progress_summary?.phase ?? progress?.phase ?? progress?.message;
  const counts = formatCounts(summary?.progress_summary ?? {});
  const detail = detailOverride ?? formatProgressDetail(progress?.detail);
  if (message && counts) {
    return detail
      ? `${message} • ${counts} • ${detail}`
      : `${message} • ${counts}`;
  }
  if (message) {
    return detail ? `${message} • ${detail}` : message;
  }
  if (counts) {
    return detail ? `${counts} • ${detail}` : counts;
  }
  if (detail) {
    return detail;
  }
  return summary?.status ?? "running";
}

function formatCounts(summary: any): string {
  const total = summary.total;
  const done = summary.done ?? summary.local ?? 0;
  const queued = summary.queued ?? 0;
  const applying = summary.applying ?? 0;
  const failed = summary.failed ?? 0;
  const canceled = summary.canceled ?? 0;
  const expired = summary.expired ?? 0;
  const parts: string[] = [];
  if (total != null) {
    parts.push(`${done}/${total} done`);
  } else {
    if (done) parts.push(`${done} done`);
  }
  if (queued) parts.push(`${queued} queued`);
  if (applying) parts.push(`${applying} applying`);
  if (failed) parts.push(`${failed} failed`);
  if (canceled) parts.push(`${canceled} canceled`);
  if (expired) parts.push(`${expired} expired`);
  return parts.join(", ");
}

function progressPercent(op: CopyLroState): number | undefined {
  const direct = clampProgressPercent(op.last_progress?.progress);
  if (direct != null) return direct;
  const summary = op.summary?.progress_summary ?? {};
  const total = summary.total;
  const done = summary.done ?? summary.local;
  if (total && done != null) {
    return clampProgressPercent((done / total) * 100);
  }
  return undefined;
}

function getUpdatedAt(op: CopyLroState): number {
  return lroUpdatedAt(op.summary);
}
