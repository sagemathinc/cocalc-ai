/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import BootLog from "../bootlog";
import { React, Rendered, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  Icon,
  LabeledRow,
  Paragraph,
  ProjectState,
  SettingBox,
  TimeElapsed,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import * as misc from "@cocalc/util/misc";
import { COMPUTE_STATES } from "@cocalc/util/schema";
import { COLORS } from "@cocalc/util/theme";
import { useProjectContext } from "../context";
import { RestartProject } from "./restart-project";
import { StopProject } from "./stop-project";
import { ArchiveProject } from "./archive-project";
import MoveProject from "./move-project";
import { Project } from "./types";
import RootFilesystemImage from "./root-filesystem-image";
import ProjectControlError from "./project-control-error";
import { RuntimeSponsorControls } from "./runtime-sponsor-controls";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  getProjectLifecycleView,
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";

interface ReactProps {
  project: Project;
  mode?: "project" | "flyout";
  showRootFilesystemImage?: boolean;
  embedded?: boolean;
}

export const ProjectControl: React.FC<ReactProps> = (props: ReactProps) => {
  const {
    project,
    mode = "project",
    showRootFilesystemImage = true,
    embedded = false,
  } = props;
  const { project_id } = useProjectContext();
  const isFlyout = mode === "flyout";
  const isEmbedded = embedded || isFlyout;
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectStatus = useTypedRedux({ project_id }, "status");
  const projectMap = useTypedRedux("projects", "project_map");
  const hostId = project.get("host_id") as string | undefined;
  const hostInfo = useHostInfo(hostId);
  const hostOperational = React.useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const hostUnavailable = !!hostId && hostOperational.state === "unavailable";
  const hostUnavailableReason =
    hostOperational.reason ?? "Assigned host is unavailable.";
  const assignedHostLabel = hostLabel(hostInfo, hostId);
  const displayStateValue = normalizeProjectStateForDisplay({
    projectState: project.getIn(["state", "state"]),
    hostId,
    hostInfo,
  });
  const lifecycle = getProjectLifecycleView({
    projectState:
      projectMap?.getIn([project_id, "state", "state"]) ??
      project.getIn(["state", "state"]),
    hostId,
    hostInfo,
    lastBackup:
      projectMap?.getIn([project_id, "last_backup"]) ??
      project.get("last_backup"),
  });
  const displayProjectState = React.useMemo(() => {
    const rawState = project.get("state");
    if (!rawState) return rawState;
    if (rawState.get("state") !== "running") return rawState;
    if (displayStateValue !== "opened") return rawState;
    return rawState.set("state", "opened");
  }, [project, displayStateValue]);

  function render_state() {
    if (lifecycle.isNew) {
      return (
        <span style={{ fontSize: "12pt", color: COLORS.GRAY_M }}>
          <Icon name="plus-circle" /> New
        </span>
      );
    }
    return (
      <span style={{ fontSize: "12pt", color: COLORS.GRAY_M }}>
        <ProjectState show_desc={true} state={displayProjectState} />
      </span>
    );
  }

  function render_stop_button(commands): Rendered {
    return (
      <StopProject
        size={isFlyout ? "small" : "large"}
        project_id={project_id}
        disabled={!commands.includes("stop")}
      />
    );
  }

  function render_restart_button(commands): Rendered {
    const allowStart = lifecycle.isRawArchived;
    return (
      <RestartProject
        size={isFlyout ? "small" : "large"}
        project_id={project_id}
        disabled={
          !allowStart &&
          !commands.includes("start") &&
          !commands.includes("stop")
        }
      />
    );
  }

  function render_lifecycle_actions(): Rendered {
    const state = displayStateValue;
    const commands = (state &&
      COMPUTE_STATES[state] &&
      COMPUTE_STATES[state].commands) || ["save", "stop", "start"];
    const archiveDisabled =
      state == null ||
      ["starting", "stopping", "archiving", "unarchiving", "archived"].includes(
        state,
      );
    const archived = lifecycle.isRawArchived;
    return (
      <section>
        <Paragraph style={{ color: COLORS.GRAY_D, marginBottom: "8px" }}>
          Use these controls when the project is stuck, needs to move hosts, or
          should be archived.
        </Paragraph>
        <Space.Compact
          style={{ marginTop: "4px", marginBottom: "10px" }}
          size={isFlyout ? "small" : "large"}
        >
          {render_restart_button(commands)}
          {render_stop_button(commands)}
          <ArchiveProject
            project_id={project_id}
            size={isFlyout ? "small" : "large"}
            disabled={archiveDisabled}
          />
          {!archived && (
            <MoveProject
              project_id={project_id}
              disabled={
                state == "starting" ||
                state == "stopping" ||
                state == "archiving" ||
                state == "unarchiving"
              }
            />
          )}
        </Space.Compact>
      </section>
    );
  }

  function render_archived_note() {
    if (lifecycle.kind !== "archived" && lifecycle.kind !== "new") {
      return;
    }
    return (
      <Paragraph style={{ color: COLORS.GRAY_D, marginBottom: "12px" }}>
        {lifecycle.kind === "archived"
          ? "Archived projects do not count toward active storage. Starting this project restores it from backup and may take a while while the RootFS image is made available on the host."
          : "This project has not been provisioned yet. Starting it will create the filesystem and make it available on the host."}
      </Paragraph>
    );
  }

  function render_uptime() {
    // start_ts is a timestamp, e.g. 1508576664416
    const start_ts = projectStatus?.get("start_ts");
    if (typeof start_ts !== "number") return;
    if (displayStateValue !== "running") {
      return;
    }

    return (
      <LabeledRow
        key="uptime"
        label={intl.formatMessage(labels.uptime)}
        style={rowStyle()}
        vertical={isFlyout}
      >
        <span style={{ color: COLORS.GRAY_M }}>
          <Icon name="clock" />{" "}
          <FormattedMessage
            id="project.settings.control.uptime.info"
            defaultMessage={`{projectLabel} started <b>{ago}</b> ago`}
            values={{ ago: <TimeElapsed start_ts={start_ts} />, projectLabel }}
          />
        </span>
      </LabeledRow>
    );
  }

  function render_cpu_usage() {
    const cpu = projectStatus?.getIn(["cpu", "usage"]) as number | undefined;
    if (cpu == undefined) {
      return;
    }
    if (displayStateValue !== "running") {
      return;
    }
    const cpu_str = misc.seconds2hms(cpu, true);
    return (
      <LabeledRow
        key="cpu-usage"
        label={intl.formatMessage({
          id: "project.settings.control.cpu_usage.label",
          defaultMessage: "CPU Usage",
        })}
        style={rowStyle(true)}
        vertical={isFlyout}
      >
        <span style={{ color: COLORS.GRAY_M }}>
          <Icon name="calculator" />{" "}
          <FormattedMessage
            id="project.settings.control.cpu_usage.info"
            defaultMessage={`used <b>{cpu_str}</b> of CPU time since {projectLabelLower} started`}
            values={{ cpu_str, projectLabelLower }}
          />
        </span>
      </LabeledRow>
    );
  }

  function rowStyle(delim?): React.CSSProperties | undefined {
    if (!delim) return;
    return {
      borderBottom: "1px solid #ddd",
      borderTop: "1px solid #ddd",
      paddingBottom: isFlyout ? undefined : "10px",
      paddingTop: "10px",
      marginBottom: "10px",
    };
  }

  function render_status_summary() {
    return (
      <>
        <LabeledRow
          key="state"
          label="State"
          style={rowStyle(true)}
          vertical={isFlyout}
        >
          {render_state()}
        </LabeledRow>
        {hostUnavailable && (
          <Paragraph style={{ color: COLORS.GRAY_D }}>
            {assignedHostLabel} is unavailable ({hostUnavailableReason}). Move
            this project to an available host, or start the assigned host.
          </Paragraph>
        )}
        {render_uptime()}
        {render_cpu_usage()}
      </>
    );
  }

  function render_runtime_diagnostics() {
    return (
      <section>
        <ProjectControlError
          style={{ margin: "10px 0px" }}
          showStopButton={project.getIn(["state", "state"]) == "running"}
        />
        <BootLog />
      </section>
    );
  }

  function render_rootfs_details() {
    if (!showRootFilesystemImage) {
      return null;
    }
    return (
      <section>
        <LabeledRow
          key="root_fs"
          label="Root Filesystem Image"
          vertical={isFlyout}
        >
          <RootFilesystemImage />
        </LabeledRow>
      </section>
    );
  }

  function renderBody() {
    return (
      <Space
        direction="vertical"
        size={isFlyout ? 10 : 14}
        style={{ width: "100%" }}
      >
        {render_lifecycle_actions()}
        <RuntimeSponsorControls project={project} project_id={project_id} />
        {render_archived_note()}
        <section>{render_status_summary()}</section>
        {render_runtime_diagnostics()}
        {render_rootfs_details()}
      </Space>
    );
  }

  if (isEmbedded) {
    return renderBody();
  } else {
    return (
      <SettingBox title={`${projectLabel} Control`} icon="gears">
        {renderBody()}
      </SettingBox>
    );
  }
};
