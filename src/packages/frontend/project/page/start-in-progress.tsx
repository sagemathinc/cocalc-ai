import { CloseOutlined } from "@ant-design/icons";
import { Button, Progress, Space, Spin, Steps, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import type { StartLroState } from "@cocalc/frontend/project/start-ops";
import { useProjectActiveOperation } from "../use-project-active-op";
import { progressBarStatus } from "@cocalc/frontend/lro/utils";
import { COLORS } from "@cocalc/util/theme";
import {
  clampProgressPercent,
  formatProgressDetail,
  lroStatusColor,
} from "../explorer/lro-timeline-utils";
import {
  isActiveOpStartLike,
  isStartActive,
  isStartInProgressActive,
} from "./start-in-progress-state";

const START_PANEL_DELAY_MS = 5000;

const START_PHASES = [
  {
    key: "queued",
    label: "Queued",
    description: "The start request is waiting to run.",
  },
  {
    key: "apply_pending_copies",
    label: "Prepare",
    description: "Apply any pending filesystem operations.",
  },
  {
    key: "prepare_config",
    label: "Runtime",
    description: "Resolve the project runtime configuration.",
  },
  {
    key: "cache_rootfs",
    label: "RootFS",
    description: "Ensure the selected RootFS image is cached on this host.",
  },
  {
    key: "runner_start",
    label: "Start",
    description: "Launch the project runtime.",
  },
  {
    key: "refresh_authorized_keys",
    label: "Access",
    description: "Refresh project access credentials.",
  },
  {
    key: "done",
    label: "Ready",
    description: "The project is ready.",
  },
] as const;

type StartPhaseKey = (typeof START_PHASES)[number]["key"];

const START_PHASE_SET = new Set<StartPhaseKey>(
  START_PHASES.map(({ key }) => key),
);

function normalizeStartPhaseKey(phase?: string): StartPhaseKey {
  const normalized = `${phase ?? ""}`.trim().toLowerCase();
  if (normalized === "start-project") {
    return "runner_start";
  }
  if (START_PHASE_SET.has(normalized as StartPhaseKey)) {
    return normalized as StartPhaseKey;
  }
  return "queued";
}

function toTimestamp(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const date = new Date(value as any);
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function phaseFromStart(
  startLro?: StartLroState,
  activeOp?: {
    phase?: string | null;
  } | null,
): StartPhaseKey {
  return normalizeStartPhaseKey(
    startLro?.last_progress?.phase ??
      startLro?.summary?.progress_summary?.phase ??
      activeOp?.phase,
  );
}

function progressPercent(
  startLro?: StartLroState,
  activeOp?: {
    phase?: string | null;
    progress?: number | null;
  } | null,
): number | undefined {
  const status = startLro?.summary?.status;
  if (status === "succeeded") return 100;
  const direct = clampProgressPercent(startLro?.last_progress?.progress);
  if (direct != null) {
    return direct;
  }
  const summaryDirect = clampProgressPercent(
    startLro?.summary?.progress_summary?.progress,
  );
  if (summaryDirect != null) {
    return summaryDirect;
  }
  const activeOpDirect = clampProgressPercent(activeOp?.progress);
  if (activeOpDirect != null) {
    return activeOpDirect;
  }
  const phase = phaseFromStart(startLro, activeOp);
  const index = START_PHASES.findIndex((entry) => entry.key === phase);
  if (index < 0) return 0;
  return Math.round((index / Math.max(1, START_PHASES.length - 1)) * 100);
}

export function getStartProgressMessage({
  phase,
  rawMessage,
  lifecycleState,
  startLroActive,
  activeOpStartLike,
}: {
  phase: StartPhaseKey;
  rawMessage: string;
  lifecycleState?: string;
  startLroActive: boolean;
  activeOpStartLike: boolean;
}): string {
  if (rawMessage && rawMessage.toLowerCase() !== phase) {
    return rawMessage;
  }
  const normalizedLifecycleState = `${lifecycleState ?? ""}`
    .trim()
    .toLowerCase();
  if (phase === "queued") {
    if (normalizedLifecycleState === "archived") {
      return "Project restore is being prepared. Archived projects can wait here while backup restore and RootFS preparation are getting ready.";
    }
    return "Project start is queued. This can take a while while backup restore and RootFS preparation are getting ready.";
  }
  if (phase === "cache_rootfs") {
    return "Making the RootFS image available on this host.";
  }
  if (
    !startLroActive &&
    !activeOpStartLike &&
    (normalizedLifecycleState === "starting" ||
      normalizedLifecycleState === "opening")
  ) {
    return "Project is starting. Detailed startup progress has not arrived yet.";
  }
  return (
    START_PHASES.find((entry) => entry.key === phase)?.description ??
    "Starting project"
  );
}

export default function StartInProgress({
  project_id,
}: {
  project_id: string;
}) {
  const projectMap = useTypedRedux("projects", "project_map");
  const startLroRecord = useTypedRedux({ project_id }, "start_lro");
  const startLro = useMemo(
    () => startLroRecord?.toJS() as StartLroState | undefined,
    [startLroRecord],
  );
  const { activeOp } = useProjectActiveOperation(project_id);
  const activeOpStartLike = isActiveOpStartLike(activeOp);
  const lifecycleState = `${
    projectMap?.getIn([project_id, "state", "state"]) ?? ""
  }`
    .trim()
    .toLowerCase();
  const active = isStartInProgressActive({
    startLro,
    activeOp,
    lifecycleState,
  });
  const startTsFromLro = toTimestamp(
    startLro?.summary?.started_at ??
      startLro?.summary?.created_at ??
      activeOp?.started_at,
  );
  const [detectedStartTs, setDetectedStartTs] = useState<number | undefined>();
  const [visible, setVisible] = useState<boolean>(false);
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();

  useEffect(() => {
    if (!active) {
      setDetectedStartTs(undefined);
      return;
    }
    setDetectedStartTs((current) => current ?? Date.now());
  }, [active, project_id, startLro?.op_id]);

  const startTs = startTsFromLro ?? detectedStartTs;
  const activeKey =
    startLro?.op_id ??
    (active
      ? `${project_id}:${startTs ?? "no-start-ts"}:${lifecycleState || "active"}`
      : undefined);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      setDismissedKey(undefined);
      return;
    }
    const elapsed = startTs == null ? 0 : Math.max(0, Date.now() - startTs);
    if (elapsed >= START_PANEL_DELAY_MS) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(
      () => setVisible(true),
      START_PANEL_DELAY_MS - elapsed,
    );
    return () => window.clearTimeout(timer);
  }, [active, startTs, startLro?.op_id]);

  if (!active || !visible || (activeKey && dismissedKey === activeKey)) {
    return null;
  }

  const phase = phaseFromStart(startLro, activeOp);
  const current = Math.max(
    0,
    START_PHASES.findIndex((entry) => entry.key === phase),
  );
  const percent = progressPercent(startLro, activeOp);
  const detailText = formatProgressDetail(
    startLro?.last_progress?.detail ??
      startLro?.summary?.progress_summary?.detail ??
      activeOp?.detail,
  );
  const rawMessage = `${
    startLro?.last_progress?.message ??
    startLro?.summary?.progress_summary?.message ??
    activeOp?.message ??
    ""
  }`.trim();
  const startLroActive = isStartActive(startLro);
  const phaseLabel = START_PHASES[current]?.label ?? "Starting";
  const actionLabel =
    activeOp?.action === "restart" ? "Restarting" : "Starting";
  const message = getStartProgressMessage({
    phase,
    rawMessage,
    lifecycleState,
    startLroActive,
    activeOpStartLike,
  });

  return (
    <div
      style={{
        margin: "12px",
        padding: "14px 16px",
        border: "1px solid #d6e4ff",
        borderRadius: "8px",
        background: "#f7fbff",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)",
      }}
    >
      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <div
          style={{
            alignItems: "flex-start",
            display: "flex",
            gap: "8px",
            justifyContent: "space-between",
          }}
        >
          <Space wrap size={[8, 8]} align="center">
            <span style={{ fontSize: "18px", fontWeight: 600 }}>
              {actionLabel} project
            </span>
            <Tag
              color={lroStatusColor(
                startLro?.summary?.status ?? activeOp?.status,
              )}
            >
              {phaseLabel}
            </Tag>
            {startTs != null ? (
              <span style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>
                Started <TimeAgo date={new Date(startTs)} />
              </span>
            ) : null}
          </Space>
          <Button
            aria-label="Dismiss startup banner"
            icon={<CloseOutlined />}
            onClick={() => setDismissedKey(activeKey ?? `${project_id}:active`)}
            size="small"
            type="text"
          >
            Dismiss
          </Button>
        </div>
        <div style={{ color: COLORS.GRAY_D, fontSize: "13px" }}>
          {message}
          {detailText ? ` · ${detailText}` : ""}
        </div>
        {percent == null ? (
          <Space size="small" align="center">
            <Spin size="small" />
            <span style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>
              Waiting for detailed startup progress…
            </span>
          </Space>
        ) : (
          <Progress
            percent={percent}
            showInfo={false}
            size="small"
            status={progressBarStatus(startLro?.summary?.status)}
          />
        )}
        <Steps
          size="small"
          current={current}
          responsive
          items={START_PHASES.map((entry) => ({
            title: entry.label,
            description: entry.description,
          }))}
        />
      </Space>
    </div>
  );
}
