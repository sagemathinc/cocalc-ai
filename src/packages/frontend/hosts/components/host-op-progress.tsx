import { Alert, Button, Popover, Progress, Space, Tag, Timeline, Typography } from "antd";
import { useMemo, useState } from "react";
import { TimeAgo, TimeElapsed } from "@cocalc/frontend/components";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import { capitalize } from "@cocalc/util/misc";
import { User } from "@cocalc/frontend/users/user";
import type { HostLroState } from "../hooks/use-host-ops";

const ACTIVE_STATUSES = new Set<LroStatus>(["queued", "running"]);

const KIND_LABELS: Record<string, string> = {
  "host-start": "Start",
  "host-stop": "Stop",
  "host-restart": "Restart",
  "host-drain": "Drain",
  "host-upgrade-software": "Upgrade",
  "host-deprovision": "Deprovision",
  "host-delete": "Delete",
  "host-force-deprovision": "Force deprovision",
  "host-remove-connector": "Remove connector",
};

const BASE_PHASES = [
  {
    key: "queued",
    label: "Queued",
    description: "Operation accepted and waiting for worker",
  },
  {
    key: "requesting",
    label: "Request",
    description: "Submitting request to host control plane",
  },
  {
    key: "waiting",
    label: "Wait",
    description: "Waiting for host state to converge",
  },
  {
    key: "done",
    label: "Complete",
    description: "Operation finished and summary persisted",
  },
] as const;

const BACKUP_PHASES = [
  BASE_PHASES[0],
  {
    key: "backups",
    label: "Backups",
    description: "Creating required workspace backups",
  },
  BASE_PHASES[1],
  BASE_PHASES[2],
  BASE_PHASES[3],
] as const;

const DRAIN_PHASES = [
  BASE_PHASES[0],
  BASE_PHASES[1],
  {
    key: "draining",
    label: "Drain",
    description: "Moving workspaces off this host",
  },
  BASE_PHASES[2],
  BASE_PHASES[3],
] as const;

type PhaseKey =
  | "queued"
  | "backups"
  | "requesting"
  | "draining"
  | "waiting"
  | "done"
  | "canceled";

type PhaseDef = {
  key: PhaseKey;
  label: string;
  description: string;
};

function phaseDefs(kind?: string): readonly PhaseDef[] {
  switch (kind) {
    case "host-stop":
    case "host-deprovision":
    case "host-delete":
      return BACKUP_PHASES;
    case "host-drain":
      return DRAIN_PHASES;
    default:
      return BASE_PHASES;
  }
}

function toTimestamp(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const date = new Date(value as any);
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function progressPercent(op: HostLroState): number | undefined {
  const progress = op.last_progress?.progress;
  if (progress != null) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }
  return undefined;
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

function normalizePhase(raw?: string): PhaseKey | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower.includes("backup")) return "backups";
  if (lower.includes("drain")) return "draining";
  if (lower.includes("request")) return "requesting";
  if (lower.includes("wait")) return "waiting";
  if (lower.includes("cancel")) return "canceled";
  if (lower.includes("done") || lower.includes("complete")) return "done";
  if (lower.includes("queue")) return "queued";
  return undefined;
}

function phaseIndex(op: HostLroState): number {
  const kind = op.summary?.kind ?? op.kind;
  const defs = phaseDefs(kind);
  const phase = normalizePhase(getHostOpPhase(op));
  if (!phase) return 0;
  const idx = defs.findIndex((entry) => entry.key === phase);
  return idx < 0 ? 0 : idx;
}

function formatDetail(detail: any): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") {
    return String(detail);
  }
  if (typeof detail !== "object") return undefined;
  if (typeof detail.error === "string" && detail.error) {
    return detail.error;
  }
  const summaryParts: string[] = [];
  if (typeof detail.status === "string") {
    summaryParts.push(`status=${detail.status}`);
  }
  if (typeof detail.completed === "number" && typeof detail.total === "number") {
    summaryParts.push(`${detail.completed}/${detail.total}`);
  }
  if (typeof detail.failed === "number") {
    summaryParts.push(`failed=${detail.failed}`);
  }
  if (summaryParts.length) return summaryParts.join(", ");
  try {
    const text = JSON.stringify(detail);
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  } catch {
    return undefined;
  }
}

function opLabel(op: HostLroState): string {
  const summary = op.summary;
  const kind = summary?.kind ?? op.kind;
  if (kind === "host-restart" && summary?.input?.mode === "hard") {
    return "Hard restart";
  }
  if (kind && KIND_LABELS[kind]) {
    return KIND_LABELS[kind];
  }
  if (kind) {
    const cleaned = kind.replace(/^host-/, "").replace(/-/g, " ");
    return capitalize(cleaned);
  }
  return "Host op";
}

export function getHostOpPhase(op?: HostLroState): string | undefined {
  if (!op) return undefined;
  return (
    op.summary?.progress_summary?.phase ??
    op.last_progress?.phase ??
    op.last_progress?.message
  );
}

function kindInputTags(op: HostLroState) {
  const summary = op.summary;
  if (!summary) return null;
  const kind = summary.kind;
  const input = summary.input ?? {};
  const tags: string[] = [];
  if (kind === "host-restart" && input.mode) {
    tags.push(`mode=${input.mode}`);
  }
  if (kind === "host-drain") {
    if (input.dest_host_id) tags.push(`dest=${input.dest_host_id}`);
    if (input.force) tags.push("force=true");
    if (input.allow_offline) tags.push("allow_offline=true");
    if (input.parallel) tags.push(`parallel=${input.parallel}`);
  }
  if (
    (kind === "host-stop" ||
      kind === "host-deprovision" ||
      kind === "host-delete") &&
    input.skip_backups
  ) {
    tags.push("skip_backups=true");
  }
  if (kind === "host-upgrade-software" && Array.isArray(input.targets)) {
    tags.push(`targets=${input.targets.join(",")}`);
  }
  if (!tags.length) return null;
  return (
    <Space size={[6, 6]} wrap>
      {tags.map((value) => (
        <Tag key={value}>{value}</Tag>
      ))}
    </Space>
  );
}

function HostOpTimeline({ op }: { op: HostLroState }) {
  const summary = op.summary;
  const status = summary?.status;
  const [copied, setCopied] = useState(false);
  const actionLabel = opLabel(op);
  const currentPhase = getHostOpPhase(op);
  const detail = formatDetail(op.last_progress?.detail);
  const kind = summary?.kind ?? op.kind;
  const defs = phaseDefs(kind);
  const activeIndex = phaseIndex(op);

  const timelineItems = useMemo(
    () =>
      defs.map((entry, index) => ({
        color: phaseColor({ index, activeIndex, status }),
        children: (
          <div>
            <div style={{ fontWeight: 600 }}>{entry.label}</div>
            <div style={{ color: "#666", fontSize: "11px" }}>{entry.description}</div>
          </div>
        ),
      })),
    [defs, activeIndex, status],
  );

  return (
    <div style={{ width: 480, maxWidth: "80vw" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <div style={{ fontWeight: 600 }}>{actionLabel} lifecycle</div>
        <Space wrap size={[6, 6]}>
          <Tag color={statusColor(status)}>{status ?? "running"}</Tag>
          {currentPhase ? <Tag>{currentPhase}</Tag> : null}
          {detail ? <Tag>{detail}</Tag> : null}
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
        {summary?.error ? (
          <Alert type="error" showIcon message="Operation failed" description={summary.error} />
        ) : null}
        <Space size="small" wrap style={{ fontSize: 12 }}>
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
        {kindInputTags(op)}
        <Timeline items={timelineItems} />
      </Space>
    </div>
  );
}

function HostOpDetailsButton({ op }: { op: HostLroState }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      content={<HostOpTimeline op={op} />}
      placement="bottomLeft"
    >
      <Button size="small" type="link" style={{ padding: 0, height: "auto" }}>
        Details
      </Button>
    </Popover>
  );
}

export function HostOpProgress({
  op,
  compact = false,
}: {
  op?: HostLroState;
  compact?: boolean;
}) {
  if (!op) {
    return null;
  }
  const summary = op.summary;
  const status = summary?.status ?? "queued";
  if (summary && summary.status !== "failed" && !ACTIVE_STATUSES.has(summary.status)) {
    return null;
  }

  const phase = getHostOpPhase(op);
  const label = phase ? capitalize(phase) : capitalize(status);
  const created_ts = toTimestamp(summary?.created_at);
  const started_ts = toTimestamp(summary?.started_at);
  const start_ts =
    created_ts != null && started_ts != null
      ? Math.min(created_ts, started_ts)
      : created_ts ?? started_ts;
  const percent = progressPercent(op);
  const actionLabel = opLabel(op);

  if (summary?.status === "failed") {
    const errorText = compact ? "Error" : `${actionLabel} failed`;
    return (
      <Space size={4} align="center" wrap>
        <Typography.Text
          type="danger"
          style={{
            fontSize: compact ? 11 : 12,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {errorText}
        </Typography.Text>
        <HostOpDetailsButton op={op} />
      </Space>
    );
  }

  if (compact) {
    return (
      <Space size={4} align="center" wrap>
        <Typography.Text
          type="secondary"
          style={{
            fontSize: 11,
            display: "inline-block",
            width: "22ch",
            maxWidth: "22ch",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {actionLabel}: {label}
          {start_ts != null && (
            <>
              {" "}· <TimeElapsed start_ts={start_ts} longform={false} />
            </>
          )}
        </Typography.Text>
        <HostOpDetailsButton op={op} />
      </Space>
    );
  }

  const isIndeterminate = percent == null;
  const displayPercent = percent ?? 0;

  return (
    <Space orientation="vertical" size={2} style={{ width: "100%" }}>
      <Space size={6} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {actionLabel}: {label}
          {start_ts != null && (
            <>
              {" "}· <TimeElapsed start_ts={start_ts} />
            </>
          )}
        </Typography.Text>
        <HostOpDetailsButton op={op} />
      </Space>
      <Progress
        percent={displayPercent}
        size="small"
        status={isIndeterminate ? "active" : undefined}
        showInfo={false}
      />
    </Space>
  );
}
