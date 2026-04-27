import {
  Alert,
  Button,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Timeline,
} from "antd";
import { useMemo, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import {
  LRO_TERMINAL_STATUSES,
  progressBarStatus,
} from "@cocalc/frontend/lro/utils";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { hostLabel } from "@cocalc/frontend/projects/host-operational";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { human_readable_size } from "@cocalc/util/misc";
import {
  clampProgressPercent,
  formatProgressDetail,
} from "../explorer/lro-timeline-utils";

const MOVE_PHASES = [
  { key: "validate", label: "Validate move request" },
  { key: "stop-source", label: "Stop source project" },
  { key: "backup", label: "Create final backup" },
  { key: "placement", label: "Update project placement" },
  { key: "start-dest", label: "Restore and start destination project" },
  { key: "cleanup", label: "Cleanup source host data" },
  { key: "done", label: "Move complete" },
] as const;

type MoveChildProgress = {
  kind?: string;
  op_id?: string;
  phase?: string;
  message?: string;
  progress?: number;
  detail?: any;
};

const TERMINAL_COLOR: Record<string, string> = {
  succeeded: "green",
  failed: "red",
  canceled: "orange",
  expired: "red",
};

function readHostId(
  moveLro: MoveLroState | undefined,
  key: string,
): string | undefined {
  if (!moveLro) return;
  const fromProgressDetail = moveLro.last_progress?.detail?.[key];
  if (typeof fromProgressDetail === "string" && fromProgressDetail) {
    return fromProgressDetail;
  }
  const fromSummaryDetail = moveLro.summary?.progress_summary?.[key];
  if (typeof fromSummaryDetail === "string" && fromSummaryDetail) {
    return fromSummaryDetail;
  }
  const fromInput = moveLro.summary?.input?.[key];
  if (typeof fromInput === "string" && fromInput) {
    return fromInput;
  }
  return;
}

function progressPercent(moveLro: MoveLroState): number | undefined {
  return clampProgressPercent(moveLro.last_progress?.progress);
}

function currentPhaseText(moveLro: MoveLroState): string {
  return (
    moveLro.last_progress?.message ??
    moveLro.last_progress?.phase ??
    moveLro.summary?.progress_summary?.phase ??
    moveLro.summary?.status ??
    "running"
  );
}

function phaseIndex(moveLro: MoveLroState): number {
  const phase = moveLro.last_progress?.phase;
  if (!phase) return 0;
  const idx = MOVE_PHASES.findIndex((entry) => entry.key === phase);
  return idx < 0 ? 0 : idx;
}

function timelineColor({
  index,
  currentIndex,
  status,
}: {
  index: number;
  currentIndex: number;
  status?: string;
}): string {
  if (status && LRO_TERMINAL_STATUSES.has(status as any)) {
    if (status === "succeeded") return "green";
    if (index <= currentIndex) return TERMINAL_COLOR[status] ?? "red";
    return "gray";
  }
  if (index < currentIndex) return "green";
  if (index === currentIndex) return "blue";
  return "gray";
}

function readMoveChildProgress(
  moveLro: MoveLroState | undefined,
): MoveChildProgress | undefined {
  const fromProgressDetail = moveLro?.last_progress?.detail?.child;
  if (fromProgressDetail != null && typeof fromProgressDetail === "object") {
    return fromProgressDetail;
  }
  const fromSummaryDetail = moveLro?.summary?.progress_summary?.child;
  if (fromSummaryDetail != null && typeof fromSummaryDetail === "object") {
    return fromSummaryDetail;
  }
  return;
}

function childOperationLabel(child?: MoveChildProgress): string {
  if (!child) return "Current sub-operation";
  if (child.kind === "project-backup") {
    return "Final backup";
  }
  if (child.kind === "project-start") {
    if (child.phase === "cache_rootfs") {
      return "Prepare RootFS on destination";
    }
    if (child.phase === "restore") {
      return "Restore backup on destination";
    }
    if (child.phase === "runner_start" || child.phase === "start") {
      return "Start destination runtime";
    }
    return "Destination start";
  }
  return "Current sub-operation";
}

function formatChildTransfer(detail?: any): string | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const parts: string[] = [];
  if (
    typeof detail.bytes_done === "number" ||
    typeof detail.bytes_total === "number"
  ) {
    const done =
      typeof detail.bytes_done === "number"
        ? human_readable_size(detail.bytes_done, true)
        : "?";
    const total =
      typeof detail.bytes_total === "number"
        ? human_readable_size(detail.bytes_total, true)
        : "?";
    parts.push(`${done} / ${total}`);
  } else if (
    typeof detail.count_done === "number" ||
    typeof detail.count_total === "number"
  ) {
    const done =
      typeof detail.count_done === "number" ? `${detail.count_done}` : "?";
    const total =
      typeof detail.count_total === "number" ? `${detail.count_total}` : "?";
    parts.push(`${done} / ${total} items`);
  }
  const detailText = formatProgressDetail(detail);
  if (detailText) {
    parts.push(detailText);
  }
  return parts.length ? parts.join(", ") : undefined;
}

function stringifyDetail(detail?: any): string | undefined {
  if (detail === undefined) return undefined;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return `${detail}`;
  }
}

export default function MoveInProgress({
  project_id,
  moveLro,
}: {
  project_id: string;
  moveLro: MoveLroState;
}) {
  const { actions } = useProjectContext();
  const [canceling, setCanceling] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [opError, setOpError] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);

  const status = moveLro.summary?.status;
  const canCancel = status != null && !LRO_TERMINAL_STATUSES.has(status);
  const phaseText = currentPhaseText(moveLro);
  const percent = progressPercent(moveLro);
  const phaseIdx = phaseIndex(moveLro);
  const childProgress = readMoveChildProgress(moveLro);
  const childPercent = clampProgressPercent(childProgress?.progress);
  const childTransfer = formatChildTransfer(childProgress?.detail);
  const childRawDetail = stringifyDetail(childProgress?.detail);

  const sourceHostId = readHostId(moveLro, "source_host_id");
  const destHostId = readHostId(moveLro, "dest_host_id");
  const sourceHostInfo = useHostInfo(sourceHostId);
  const destHostInfo = useHostInfo(destHostId);
  const sourceHostText = hostLabel(sourceHostInfo, sourceHostId);
  const destHostText = hostLabel(destHostInfo, destHostId);

  const createdBy = moveLro.summary?.created_by;
  const createdAt = moveLro.summary?.created_at;
  const updatedAt = moveLro.summary?.updated_at;

  const timelineItems = useMemo(() => {
    const items = [
      {
        color: "green",
        children: (
          <>
            <div style={{ fontWeight: 600 }}>Move request created</div>
            <div style={{ marginTop: "4px" }}>
              <Space size="small" wrap>
                {createdBy ? (
                  <span>
                    Initiated by{" "}
                    <User account_id={createdBy} show_avatar avatarSize={18} />
                  </span>
                ) : (
                  <span>Initiated by unknown user</span>
                )}
                {createdAt != null && (
                  <span>
                    at <TimeAgo date={createdAt} />
                  </span>
                )}
              </Space>
            </div>
          </>
        ),
      },
      {
        color: sourceHostId ? "blue" : "gray",
        children: (
          <>
            <div style={{ fontWeight: 600 }}>Source host</div>
            <div>{sourceHostText}</div>
          </>
        ),
      },
      {
        color: destHostId ? "blue" : "gray",
        children: (
          <>
            <div style={{ fontWeight: 600 }}>Destination host</div>
            <div>{destHostText}</div>
          </>
        ),
      },
    ];

    for (const [index, phase] of MOVE_PHASES.entries()) {
      items.push({
        color: timelineColor({
          index,
          currentIndex: phaseIdx,
          status,
        }),
        children: <span>{phase.label}</span>,
      });
    }
    return items;
  }, [
    createdBy,
    createdAt,
    sourceHostId,
    sourceHostText,
    destHostId,
    destHostText,
    phaseIdx,
    status,
  ]);

  const renderStatusAlert = () => {
    if (status === "failed") {
      return (
        <Alert
          showIcon
          type="error"
          title="Project move failed"
          description={moveLro.summary?.error ?? "The move operation failed."}
        />
      );
    }
    if (status === "canceled") {
      return (
        <Alert
          showIcon
          type="warning"
          title="Project move canceled"
          description="The move operation was canceled."
        />
      );
    }
    if (status === "expired") {
      return (
        <Alert
          showIcon
          type="error"
          title="Project move expired"
          description="The move operation expired before completion."
        />
      );
    }
    return (
      <Alert
        showIcon
        type="info"
        title="Moving project..."
        description={
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            <div>{phaseText}</div>
            <div>
              <Space size="small" wrap>
                <Tag color="processing">Status: {status ?? "running"}</Tag>
                {updatedAt != null && (
                  <Tag color="default">
                    Last update: <TimeAgo date={updatedAt} />
                  </Tag>
                )}
              </Space>
            </div>
            {percent == null ? (
              <div>
                <Icon name="cocalc-ring" spin /> Working...
              </div>
            ) : (
              <Progress
                percent={percent}
                status={progressBarStatus(status)}
                style={{ maxWidth: "460px" }}
              />
            )}
          </Space>
        }
      />
    );
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        overflowX: "auto",
      }}
    >
      <div style={{ maxWidth: "980px", width: "100%", padding: "0 24px" }}>
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {renderStatusAlert()}
          {childProgress ? (
            <div
              style={{
                border: "1px solid var(--antd-border-color, #d9d9d9)",
                borderRadius: "8px",
                padding: "12px",
              }}
            >
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <div style={{ fontWeight: 600 }}>Current sub-operation</div>
                <Space size="small" wrap>
                  <Tag color="processing">
                    {childOperationLabel(childProgress)}
                  </Tag>
                  {childProgress.op_id ? (
                    <Tag>
                      Operation ID: <code>{childProgress.op_id}</code>
                    </Tag>
                  ) : null}
                  {childTransfer ? <Tag>{childTransfer}</Tag> : null}
                </Space>
                <div>
                  {childProgress.message ??
                    childProgress.phase ??
                    "Working on a child operation"}
                </div>
                {childPercent != null ? (
                  <Progress
                    percent={childPercent}
                    size="small"
                    status={progressBarStatus(status)}
                    style={{ maxWidth: "460px" }}
                  />
                ) : null}
                {childRawDetail ? (
                  <details>
                    <summary>Details</summary>
                    <pre
                      style={{
                        marginTop: "8px",
                        marginBottom: 0,
                        maxHeight: "220px",
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {childRawDetail}
                    </pre>
                  </details>
                ) : null}
              </Space>
            </div>
          ) : null}
          {opError ? (
            <Alert
              showIcon
              type="error"
              title="Move operation error"
              description={opError}
              closable
              onClose={() => setOpError("")}
            />
          ) : null}
          <Timeline items={timelineItems} />
          <Space size="small" wrap style={{ fontSize: "12px", color: "#666" }}>
            <span>
              Operation ID: <code>{moveLro.op_id}</code>
            </span>
            <Button
              type="link"
              size="small"
              onClick={async () => {
                await navigator.clipboard.writeText(moveLro.op_id);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy ID"}
            </Button>
          </Space>
          <Space wrap>
            <Button
              size="large"
              loading={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  actions?.trackMoveOp({
                    op_id: moveLro.op_id,
                    scope_type: "project",
                    scope_id: project_id,
                  });
                  const projectActions = redux.getActions("projects");
                  for (const host_id of [sourceHostId, destHostId]) {
                    if (!host_id) continue;
                    await projectActions?.ensure_host_info(host_id, true);
                  }
                } catch (err) {
                  setOpError(`${err}`);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <Icon name="refresh" /> Refresh status
            </Button>
            {canCancel ? (
              <Popconfirm
                title="Cancel this project move?"
                okText="Cancel move"
                cancelText="Keep moving"
                onConfirm={async () => {
                  try {
                    setCanceling(true);
                    await webapp_client.conat_client.hub.lro.cancel({
                      op_id: moveLro.op_id,
                    });
                    actions?.trackMoveOp({
                      op_id: moveLro.op_id,
                      scope_type: "project",
                      scope_id: project_id,
                    });
                  } catch (err) {
                    setOpError(`${err}`);
                  } finally {
                    setCanceling(false);
                  }
                }}
              >
                <Button size="large" danger loading={canceling}>
                  <Icon name="times-circle" /> Cancel move
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        </Space>
      </div>
    </div>
  );
}
