import { useEffect } from "react";
import type { CSSProperties } from "react";
import { Alert, Progress, Space, Tag } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { getProjectLifecycleView } from "@cocalc/frontend/projects/host-operational";
import { COLORS } from "@cocalc/util/theme";

type ArchivePhase = {
  label: string;
  percent: number;
  detail: string;
};

const ARCHIVE_CONTROL_STATUS: Record<string, ArchivePhase> = {
  "Checking backups before archive...": {
    label: "Checking backups",
    percent: 20,
    detail:
      "CoCalc is checking whether an existing backup already covers the latest edits.",
  },
  "Stopping project before final backup...": {
    label: "Stopping project",
    percent: 40,
    detail:
      "The running project is stopping first so the final backup is consistent.",
  },
  "Creating final backup before archive...": {
    label: "Final backup",
    percent: 65,
    detail:
      "CoCalc is making a final backup before removing the host copy and filesystem snapshots.",
  },
  "Archiving project...": {
    label: "Archiving",
    percent: 90,
    detail:
      "The active host copy and filesystem snapshots are being removed. Backups are retained for restore.",
  },
  "Archiving project from deprovisioned host...": {
    label: "Deprovisioned host",
    percent: 80,
    detail:
      "The assigned host is already deprovisioned, so CoCalc is marking the project archived without host-side cleanup.",
  },
  "Archiving project using the latest available backup...": {
    label: "Using latest backup",
    percent: 75,
    detail:
      "The assigned host is unavailable, so CoCalc is archiving from the latest available backup instead of creating a final one.",
  },
};

const STALE_ARCHIVE_CONTROL_STATUS = new Set(
  Object.keys(ARCHIVE_CONTROL_STATUS),
);

export default function ProjectControlStatus({
  style,
  banner = false,
}: {
  style?: any;
  banner?: boolean;
}) {
  const { project_id } = useProjectContext();
  const control_status = useTypedRedux({ project_id }, "control_status");
  const projectMap = useTypedRedux("projects", "project_map");
  const lifecycle = getProjectLifecycleView({
    projectState: projectMap?.getIn([project_id, "state", "state"]),
    lastBackup: projectMap?.getIn([project_id, "last_backup"]),
  });
  const hideStaleArchiveStatus =
    STALE_ARCHIVE_CONTROL_STATUS.has(`${control_status ?? ""}`) &&
    lifecycle.isRawArchived;

  useEffect(() => {
    if (!hideStaleArchiveStatus) {
      return;
    }
    redux.getProjectActions(project_id)?.setState({ control_status: "" });
  }, [hideStaleArchiveStatus, project_id]);

  if (!control_status || hideStaleArchiveStatus) {
    return null;
  }

  const archivePhase = ARCHIVE_CONTROL_STATUS[`${control_status}`];
  if (archivePhase != null) {
    return (
      <ArchiveControlStatusBanner
        phase={archivePhase}
        rawStatus={`${control_status}`}
        style={style}
      />
    );
  }

  return (
    <Alert
      banner={banner}
      type="info"
      showIcon={!banner}
      message={control_status}
      style={style}
    />
  );
}

function ArchiveControlStatusBanner({
  phase,
  rawStatus,
  style,
}: {
  phase: ArchivePhase;
  rawStatus: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: COLORS.YELL_LLL,
        border: `1px solid ${COLORS.YELL_LL}`,
        borderRadius: "8px",
        margin: "12px",
        padding: "14px 16px",
        ...style,
      }}
    >
      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <Space wrap size={[8, 8]} align="center">
          <span style={{ fontSize: "18px", fontWeight: 600 }}>
            Archiving project
          </span>
          <Tag color="gold">{phase.label}</Tag>
          <span style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>
            Critical storage operation
          </span>
        </Space>
        <div style={{ color: COLORS.GRAY_D, fontSize: "13px" }}>
          {phase.detail}
        </div>
        <Progress
          percent={phase.percent}
          showInfo={false}
          size="small"
          status="active"
          strokeColor={COLORS.COCALC_ORANGE}
          trailColor={COLORS.GRAY_LL}
        />
        <div style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>
          {rawStatus}
        </div>
      </Space>
    </div>
  );
}
