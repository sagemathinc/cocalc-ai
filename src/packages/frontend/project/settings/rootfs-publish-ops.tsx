import { Button, Popover, Progress, Space, Tag } from "antd";
import { useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import {
  LRO_TERMINAL_STATUSES,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { RootfsPublishLroState } from "@cocalc/frontend/project/rootfs-publish-ops";
import { webapp_client } from "@cocalc/frontend/webapp-client";
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
  const visible = entries.filter((op) => op.summary?.dismissed_at == null);
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
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const percent = progressPercent(op);
  const status = op.summary?.status;
  const phase = phaseLabel(op);
  const message = op.last_progress?.message ?? statusLabel(status);
  const progressStatus = progressBarStatus(status);
  const requestedLabel = `${op.summary?.input?.label ?? ""}`.trim();
  const resultImage = `${op.summary?.result?.image ?? ""}`.trim();
  const durationMs = Number(
    op.summary?.result?.duration_ms ??
      op.summary?.progress_summary?.duration_ms,
  );
  const phaseTimings = op.summary?.result?.phase_timings_ms;
  const errorText = `${op.summary?.error ?? ""}`.trim();
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
    <div
      style={{
        marginBottom: "8px",
        padding: "8px",
        border: "1px solid #eee",
        borderRadius: "4px",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
        {requestedLabel || "Publish current project RootFS state"}
      </div>
      <div style={{ marginBottom: "6px" }}>
        <Progress
          percent={percent}
          status={progressStatus}
          size="small"
          style={{ width: "100%", maxWidth: "320px" }}
        />
      </div>
      <Space size="small" align="center" wrap style={{ marginBottom: "4px" }}>
        <span style={{ fontSize: "11px", color: "#666" }}>
          {phase}
          {message ? `: ${message}` : ""}
        </span>
        {status ? <Tag color={statusColor(status)}>{status}</Tag> : null}
        {op.summary?.updated_at ? (
          <span style={{ fontSize: "11px", color: "#999" }}>
            <TimeAgo date={op.summary.updated_at} />
          </span>
        ) : null}
      </Space>
      {resultImage ? (
        <div style={{ fontSize: "11px", color: "#444", marginBottom: "4px" }}>
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
        <div style={{ fontSize: "11px", color: "#666", marginBottom: "4px" }}>
          {formatTimingSummary(durationMs, phaseTimings)}
        </div>
      ) : null}
      <Space size="small" align="center" wrap>
        <Popover
          trigger="click"
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          placement="bottomLeft"
          content={
            <RootfsPublishDetails
              op={op}
              copied={copied}
              setCopied={setCopied}
              errorText={errorText}
              dismissible={dismissible}
              onDismiss={dismissOp}
            />
          }
        >
          <Button type="link" size="small">
            Details
          </Button>
        </Popover>
        {dismissible ? (
          <Button type="link" size="small" onClick={dismissOp}>
            Dismiss
          </Button>
        ) : null}
      </Space>
    </div>
  );
}

function RootfsPublishDetails({
  op,
  copied,
  setCopied,
  errorText,
  dismissible,
  onDismiss,
}: {
  op: RootfsPublishLroState;
  copied: boolean;
  setCopied: (value: boolean) => void;
  errorText: string;
  dismissible: boolean;
  onDismiss: () => Promise<void>;
}) {
  const requestedLabel = `${op.summary?.input?.label ?? ""}`.trim();
  const result = op.summary?.result ?? {};
  const resultImage = `${result.image ?? ""}`.trim();
  const durationMs = Number(
    result.duration_ms ?? op.summary?.progress_summary?.duration_ms,
  );
  const phaseTimings = result.phase_timings_ms;

  return (
    <div style={{ width: "640px", maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Space wrap size={[6, 6]}>
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
        {dismissible ? (
          <Button size="small" onClick={() => void onDismiss()}>
            Dismiss
          </Button>
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

function formatTimingSummary(
  durationMs: number,
  phaseTimings?: Record<string, number>,
): string {
  const parts: string[] = [];
  if (Number.isFinite(durationMs)) {
    parts.push(`total ${formatDurationMs(durationMs)}`);
  }
  for (const key of ["publish", "upload", "replicate", "catalog_entry"]) {
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
