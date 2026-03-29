import { Button, Popover, Progress, Space, Spin, Tag, Timeline } from "antd";
import { useMemo, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  LRO_TERMINAL_STATUSES,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { RootfsPublishLroState } from "@cocalc/frontend/project/rootfs-publish-ops";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  clampProgressPercent,
  formatProgressDetail,
  lroPhaseColor,
  lroStatusColor,
  lroUpdatedAt,
} from "../explorer/lro-timeline-utils";

const ROOTFS_PUBLISH_PHASES = [
  {
    key: "queued",
    label: "Queued",
    description: "Operation accepted and waiting for a publish slot",
  },
  {
    key: "validate",
    label: "Validate",
    description: "Resolve the source project and publish destination",
  },
  {
    key: "snapshot",
    label: "Snapshot",
    description: "Capture a publishable filesystem snapshot",
  },
  {
    key: "publish",
    label: "Assemble",
    description: "Prepare the merged RootFS tree for release",
  },
  {
    key: "upload",
    label: "Upload",
    description: "Save the RootFS release into rustic storage",
  },
  {
    key: "catalog",
    label: "Catalog",
    description: "Register the published RootFS image in the catalog",
  },
  {
    key: "done",
    label: "Complete",
    description: "Publish completed and metadata persisted",
  },
] as const;

type RootfsPublishPhaseKey = (typeof ROOTFS_PUBLISH_PHASES)[number]["key"];

const ROOTFS_PHASE_SET = new Set<RootfsPublishPhaseKey>(
  ROOTFS_PUBLISH_PHASES.map((phase) => phase.key),
);

const PHASE_BASELINE: Record<RootfsPublishPhaseKey, number> = {
  queued: 0,
  validate: 5,
  snapshot: 15,
  publish: 45,
  upload: 70,
  catalog: 96,
  done: 100,
};

export default function RootfsPublishOps({
  project_id,
}: {
  project_id: string;
}) {
  const publishOps =
    useTypedRedux({ project_id }, "rootfs_publish_ops")?.toJS() ?? {};
  const entries = Object.values(publishOps) as RootfsPublishLroState[];
  const visible = entries.filter((op) => op.summary?.dismissed_at == null);
  if (!visible.length) {
    return null;
  }
  visible.sort((a, b) => lroUpdatedAt(b.summary) - lroUpdatedAt(a.summary));

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
  const summary = op.summary;
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const percent = progressPercent(op);
  const status = summary?.status;
  const progress = op.last_progress;
  const detail = formatProgressDetail(progress?.detail);
  const lastDetailRef = useRef<string | undefined>(undefined);
  if (detail) {
    lastDetailRef.current = detail;
  }
  const statusText = formatStatusLine(op, detail ?? lastDetailRef.current);
  const progressStatus = progressBarStatus(status);
  const requestedLabel = `${summary?.input?.label ?? ""}`.trim();
  const resultImage = `${summary?.result?.image ?? ""}`.trim();
  const durationMs = Number(
    summary?.result?.duration_ms ?? summary?.progress_summary?.duration_ms,
  );
  const phaseTimings = summary?.result?.phase_timings_ms;
  const dismissible = !!status && LRO_TERMINAL_STATUSES.has(status);

  async function dismissOp() {
    await webapp_client.conat_client.hub.lro.dismiss({
      op_id: op.op_id,
    });
    setDismissed(true);
  }

  if (dismissed) {
    return null;
  }

  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ fontSize: "12px", marginBottom: "2px" }}>
        {requestedLabel || "Publish current project RootFS state"}
      </div>
      <Space size="small" align="center" wrap>
        {percent == null ? (
          <Spin size="small" />
        ) : (
          <Progress
            percent={percent}
            status={progressStatus}
            size="small"
            style={{ width: "220px" }}
          />
        )}
        <span style={{ fontSize: "11px", color: "#666" }}>{statusText}</span>
        {status ? <Tag color={lroStatusColor(status)}>{status}</Tag> : null}
        {summary?.updated_at ? (
          <span style={{ fontSize: "11px", color: "#999" }}>
            <TimeAgo date={summary.updated_at} />
          </span>
        ) : null}
        <Popover
          trigger="click"
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          placement="bottomLeft"
          overlayInnerStyle={{
            maxHeight: "75vh",
            overflowY: "auto",
            maxWidth: "min(92vw, 560px)",
          }}
          content={<RootfsPublishTimeline op={op} onDismiss={dismissOp} />}
        >
          <Button type="link" size="small">
            Timeline
          </Button>
        </Popover>
        {dismissible ? (
          <Button type="link" size="small" onClick={() => void dismissOp()}>
            Dismiss
          </Button>
        ) : null}
      </Space>
      {resultImage ? (
        <div style={{ fontSize: "11px", color: "#444", marginTop: "4px" }}>
          <span style={{ color: "#666" }}>Image:</span>{" "}
          <code
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              overflowWrap: "anywhere",
            }}
          >
            {resultImage}
          </code>
        </div>
      ) : null}
      {Number.isFinite(durationMs) || phaseTimings ? (
        <div style={{ fontSize: "11px", color: "#666", marginTop: "2px" }}>
          {formatTimingSummary(durationMs, phaseTimings)}
        </div>
      ) : null}
    </div>
  );
}

function RootfsPublishTimeline({
  op,
  onDismiss,
}: {
  op: RootfsPublishLroState;
  onDismiss: () => Promise<void>;
}) {
  const summary = op.summary;
  const status = summary?.status;
  const detailText = formatProgressDetail(op.last_progress?.detail);
  const statusText = formatStatusLine(op);
  const phase = phaseFromOp(op);
  const activeIndex = phase != null ? phaseIndex(phase) : 0;
  const [copied, setCopied] = useState<boolean>(false);
  const requestedLabel = `${summary?.input?.label ?? ""}`.trim();
  const resultImage = `${summary?.result?.image ?? ""}`.trim();
  const durationMs = Number(
    summary?.result?.duration_ms ?? summary?.progress_summary?.duration_ms,
  );
  const phaseTimings = summary?.result?.phase_timings_ms;
  const errorText = `${summary?.error ?? ""}`.trim();
  const dismissible = !!status && LRO_TERMINAL_STATUSES.has(status);

  const timelineItems = useMemo(() => {
    return ROOTFS_PUBLISH_PHASES.map((entry, index) => ({
      color: lroPhaseColor({ index, activeIndex, status }),
      children: (
        <div>
          <div style={{ fontWeight: 600 }}>{entry.label}</div>
          <div style={{ color: "#666", fontSize: "11px" }}>
            {entry.description}
          </div>
        </div>
      ),
    }));
  }, [activeIndex, status]);

  return (
    <div style={{ width: "520px", maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div style={{ fontWeight: 600 }}>RootFS publish lifecycle</div>
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
              Initiated by{" "}
              <User
                account_id={summary.created_by}
                show_avatar
                avatarSize={16}
              />
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
        {requestedLabel ? (
          <div style={{ fontSize: "12px" }}>
            <strong>Label:</strong> {requestedLabel}
          </div>
        ) : null}
        {resultImage ? (
          <div style={{ fontSize: "12px" }}>
            <strong>Image:</strong>{" "}
            <code
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                overflowWrap: "anywhere",
              }}
            >
              {resultImage}
            </code>
          </div>
        ) : null}
        {Number.isFinite(durationMs) || phaseTimings ? (
          <div style={{ fontSize: "12px" }}>
            <strong>Timings:</strong>{" "}
            {formatTimingSummary(durationMs, phaseTimings)}
          </div>
        ) : null}
        {errorText ? (
          <div
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              fontSize: "12px",
            }}
          >
            {errorText}
          </div>
        ) : null}
        <Timeline items={timelineItems} />
        {dismissible ? (
          <Button size="small" onClick={() => void onDismiss()}>
            Dismiss
          </Button>
        ) : null}
      </Space>
    </div>
  );
}

function phaseFromOp(
  op: RootfsPublishLroState,
): RootfsPublishPhaseKey | undefined {
  const phaseRaw =
    op.last_progress?.phase ??
    op.summary?.progress_summary?.phase ??
    op.last_progress?.message;
  if (typeof phaseRaw !== "string" || !phaseRaw.trim()) return;
  const lower = phaseRaw.trim().toLowerCase();
  if (ROOTFS_PHASE_SET.has(lower as RootfsPublishPhaseKey)) {
    return lower as RootfsPublishPhaseKey;
  }
}

function phaseIndex(phase: RootfsPublishPhaseKey): number {
  const index = ROOTFS_PUBLISH_PHASES.findIndex((entry) => entry.key === phase);
  return index >= 0 ? index : 0;
}

function formatStatusLine(
  op: RootfsPublishLroState,
  detailOverride?: string,
): string {
  const phase = phaseFromOp(op);
  const phaseLabel =
    phase != null
      ? (ROOTFS_PUBLISH_PHASES.find((entry) => entry.key === phase)?.label ??
        phase)
      : "Running";
  const message = `${op.last_progress?.message ?? ""}`.trim();
  const detail =
    detailOverride ?? formatProgressDetail(op.last_progress?.detail);
  const parts = [phaseLabel];
  if (message && message.toLowerCase() !== phase) {
    parts.push(message);
  }
  if (detail) {
    parts.push(detail);
  }
  return parts.join(" · ");
}

function progressPercent(op: RootfsPublishLroState): number | undefined {
  const status = op.summary?.status;
  if (status === "succeeded") return 100;
  if (status && LRO_TERMINAL_STATUSES.has(status)) return 100;
  const phase = phaseFromOp(op);
  const direct = clampProgressPercent(op.last_progress?.progress);
  if (phase === "upload" && direct != null) {
    return 70 + Math.round((direct * 22) / 100);
  }
  if (direct != null) {
    return direct;
  }
  return phase ? PHASE_BASELINE[phase] : 0;
}

function formatTimingSummary(
  durationMs: number,
  phaseTimings?: Record<string, number>,
): string {
  const parts: string[] = [];
  if (Number.isFinite(durationMs)) {
    parts.push(`total ${formatDurationMs(durationMs)}`);
  }
  for (const key of ["validate", "publish", "catalog_entry", "upload"]) {
    const value = Number(phaseTimings?.[key]);
    if (Number.isFinite(value) && value > 0) {
      parts.push(`${keyLabel(key)} ${formatDurationMs(value)}`);
    }
  }
  return parts.join(" · ");
}

function keyLabel(key: string): string {
  switch (key) {
    case "catalog_entry":
      return "catalog";
    default:
      return key;
  }
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}
