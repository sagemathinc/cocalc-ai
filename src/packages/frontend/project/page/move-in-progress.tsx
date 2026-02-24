import { Alert, Button, Popconfirm, Progress, Space, Tag, Timeline } from "antd";
import { useMemo, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { LRO_TERMINAL_STATUSES, progressBarStatus } from "@cocalc/frontend/lro/utils";
import type { MoveLroState } from "@cocalc/frontend/project/move-ops";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { hostLabel } from "@cocalc/frontend/projects/host-operational";
import { User } from "@cocalc/frontend/users/user";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const MOVE_PHASES = [
  { key: "validate", label: "Validate move request" },
  { key: "stop-source", label: "Stop source workspace" },
  { key: "backup", label: "Prepare backup state" },
  { key: "placement", label: "Update workspace placement" },
  { key: "start-dest", label: "Start destination workspace" },
  { key: "cleanup", label: "Cleanup source host data" },
  { key: "done", label: "Move complete" },
] as const;

const TERMINAL_COLOR: Record<string, string> = {
  succeeded: "green",
  failed: "red",
  canceled: "orange",
  expired: "red",
};

function readHostId(moveLro: MoveLroState | undefined, key: string): string | undefined {
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
  const progress = moveLro.last_progress?.progress;
  if (progress == null) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress)));
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

  const status = moveLro.summary?.status;
  const canCancel = status != null && !LRO_TERMINAL_STATUSES.has(status);
  const phaseText = currentPhaseText(moveLro);
  const percent = progressPercent(moveLro);
  const phaseIdx = phaseIndex(moveLro);

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
                    Initiated by <User account_id={createdBy} show_avatar avatarSize={18} />
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
          message="Workspace move failed"
          description={moveLro.summary?.error ?? "The move operation failed."}
        />
      );
    }
    if (status === "canceled") {
      return (
        <Alert
          showIcon
          type="warning"
          message="Workspace move canceled"
          description="The move operation was canceled."
        />
      );
    }
    if (status === "expired") {
      return (
        <Alert
          showIcon
          type="error"
          message="Workspace move expired"
          description="The move operation expired before completion."
        />
      );
    }
    return (
      <Alert
        showIcon
        type="info"
        message="Moving workspace..."
        description={
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
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
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {renderStatusAlert()}
          {opError ? (
            <Alert
              showIcon
              type="error"
              message="Move operation error"
              description={opError}
              closable
              onClose={() => setOpError("")}
            />
          ) : null}
          <Timeline items={timelineItems} />
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
                title="Cancel this workspace move?"
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
