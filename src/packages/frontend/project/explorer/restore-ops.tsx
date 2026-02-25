import {
  Button,
  Popconfirm,
  Popover,
  Progress,
  Space,
  Spin,
  Tag,
  Timeline,
} from "antd";
import { useMemo, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import {
  LRO_TERMINAL_STATUSES,
  isDismissed,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { RestoreLroState } from "@cocalc/frontend/project/restore-ops";
import { TimeAgo } from "@cocalc/frontend/components";
import { User } from "@cocalc/frontend/users/user";
import {
  clampProgressPercent,
  formatProgressDetail,
  lroPhaseColor,
  lroStatusColor,
  lroUpdatedAt,
} from "./lro-timeline-utils";

const HIDE_STATUSES = new Set<LroStatus>(["succeeded"]);

const RESTORE_PHASES = [
  {
    key: "queued",
    label: "Queued",
    description: "Operation accepted and waiting for worker",
  },
  {
    key: "validate",
    label: "Validate",
    description: "Validate backup id and restore target",
  },
  {
    key: "restore",
    label: "Restore",
    description: "Restore selected backup contents",
  },
  {
    key: "done",
    label: "Complete",
    description: "Restore completed and summary persisted",
  },
] as const;

type RestorePhaseKey = (typeof RESTORE_PHASES)[number]["key"];

const RESTORE_PHASE_SET = new Set<RestorePhaseKey>(
  RESTORE_PHASES.map((phase) => phase.key),
);

export default function RestoreOps({ project_id }: { project_id: string }) {
  const restoreOps =
    useTypedRedux({ project_id }, "restore_ops")?.toJS() ?? {};
  const entries = Object.values(restoreOps) as RestoreLroState[];
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
        Restore operations
      </div>
      {active.map((op) => (
        <RestoreOpRow key={op.op_id} op={op} />
      ))}
    </div>
  );
}

function RestoreOpRow({ op }: { op: RestoreLroState }) {
  const summary = op.summary;
  if (summary && HIDE_STATUSES.has(summary.status)) {
    return null;
  }
  const lastDetailRef = useRef<string | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const percent = progressPercent(op);
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
      <div style={{ fontSize: "12px", marginBottom: "2px" }}>Restore operation</div>
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
          content={<RestoreOpTimeline op={op} />}
          placement="bottomLeft"
        >
          <Button type="link" size="small">
            Timeline
          </Button>
        </Popover>
        {canCancel ? (
          <Popconfirm
            title="Cancel this restore operation?"
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
        ) : null}
      </Space>
    </div>
  );
}

function RestoreOpTimeline({ op }: { op: RestoreLroState }) {
  const summary = op.summary;
  const status = summary?.status;
  const detailText = formatProgressDetail(op.last_progress?.detail);
  const statusText = formatStatusLine(op);
  const phase = phaseFromOp(op);
  const activeIndex = phase != null ? phaseIndex(phase) : 0;
  const [copied, setCopied] = useState<boolean>(false);

  const timelineItems = useMemo(() => {
    return RESTORE_PHASES.map((entry, index) => ({
      color: lroPhaseColor({ index, activeIndex, status }),
      children: (
        <div>
          <div style={{ fontWeight: 600 }}>{entry.label}</div>
          <div style={{ color: "#666", fontSize: "11px" }}>{entry.description}</div>
        </div>
      ),
    }));
  }, [activeIndex, status]);

  return (
    <div style={{ width: "460px", maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div style={{ fontWeight: 600 }}>Restore operation lifecycle</div>
        <Space wrap size={[6, 6]}>
          <Tag color={lroStatusColor(status)}>{status ?? "running"}</Tag>
          {detailText ? <Tag>{detailText}</Tag> : null}
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
              Initiated by <User account_id={summary.created_by} show_avatar avatarSize={16} />
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
          {summary?.input?.id ? (
            <span>Backup ID: {summary.input.id}</span>
          ) : (
            <span>Backup metadata unavailable.</span>
          )}
          {summary?.input?.path || summary?.input?.dest ? (
            <>
              <br />
              <span>
                {summary.input.path ? `Path: ${summary.input.path}` : ""}
                {summary.input.path && summary.input.dest ? " • " : ""}
                {summary.input.dest ? `Destination: ${summary.input.dest}` : ""}
              </span>
            </>
          ) : null}
        </div>
        <Timeline items={timelineItems} />
      </Space>
    </div>
  );
}

function phaseFromOp(op: RestoreLroState): RestorePhaseKey | undefined {
  const phaseRaw =
    op.last_progress?.phase ??
    op.summary?.progress_summary?.phase ??
    op.last_progress?.message;
  if (typeof phaseRaw !== "string" || !phaseRaw.trim()) return;
  const lower = phaseRaw.trim().toLowerCase();
  if (RESTORE_PHASE_SET.has(lower as RestorePhaseKey)) {
    return lower as RestorePhaseKey;
  }
  if (lower.includes("validate")) return "validate";
  if (lower.includes("restore")) return "restore";
  if (lower.includes("done") || lower.includes("complete")) return "done";
  if (lower.includes("queue")) return "queued";
  return;
}

function phaseIndex(phase: RestorePhaseKey): number {
  const idx = RESTORE_PHASES.findIndex((entry) => entry.key === phase);
  return idx < 0 ? 0 : idx;
}

function formatStatusLine(
  op: RestoreLroState,
  detailOverride?: string,
): string {
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
  const progress = op.last_progress;
  const message =
    summary?.progress_summary?.phase ?? progress?.phase ?? progress?.message;
  const detail = detailOverride ?? formatProgressDetail(progress?.detail);
  if (message && detail) {
    return `${message} • ${detail}`;
  }
  if (message) {
    return message;
  }
  if (detail) {
    return detail;
  }
  return summary?.status ?? "running";
}

function progressPercent(op: RestoreLroState): number | undefined {
  return clampProgressPercent(op.last_progress?.progress);
}

function getUpdatedAt(op: RestoreLroState): number {
  return lroUpdatedAt(op.summary);
}
