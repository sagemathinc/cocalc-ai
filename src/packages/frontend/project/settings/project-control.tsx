/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import BootLog from "../bootlog";
import { React, redux, Rendered } from "@cocalc/frontend/app-framework";
import {
  A,
  Icon,
  LabeledRow,
  Paragraph,
  ProjectState,
  SettingBox,
  TimeAgo,
  TimeElapsed,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import * as misc from "@cocalc/util/misc";
import { COMPUTE_STATES } from "@cocalc/util/schema";
import { COLORS } from "@cocalc/util/theme";
import { useProjectContext } from "../context";
import { RestartProject } from "./restart-project";
import { StopProject } from "./stop-project";
import MoveProject from "./move-project";
import { Project } from "./types";
import RootFilesystemImage from "./root-filesystem-image";
import ProjectControlError from "./project-control-error";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";

interface ReactProps {
  project: Project;
  mode?: "project" | "flyout";
}

export const ProjectControl: React.FC<ReactProps> = (props: ReactProps) => {
  const { project, mode = "project" } = props;
  const { project_id } = useProjectContext();
  const isFlyout = mode === "flyout";
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
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
  const displayProjectState = React.useMemo(() => {
    const rawState = project.get("state");
    if (!rawState) return rawState;
    if (rawState.get("state") !== "running") return rawState;
    if (displayStateValue !== "opened") return rawState;
    return rawState.set("state", "opened");
  }, [project, displayStateValue]);

  function render_state() {
    return (
      <span style={{ fontSize: "12pt", color: COLORS.GRAY_M }}>
        <ProjectState show_desc={true} state={displayProjectState} />
      </span>
    );
  }

  function render_idle_timeout() {
    // get_idle_timeout_horizon depends on the project object, so this
    // will update properly....
    const date = redux
      .getStore("projects")
      .get_idle_timeout_horizon(project_id);
    if (date == null) {
      // e.g., viewing as admin where the info about idle timeout
      // horizon simply isn't known.
      return <span style={{ color: COLORS.GRAY_M }}>(not available)</span>;
    }
    return (
      <span style={{ color: COLORS.GRAY_M }}>
        <Icon name="hourglass-half" />{" "}
        <FormattedMessage
          id="project.settings.control.idle_timeout.info"
          defaultMessage={`<b>About {ago}</b> {projectLabelLower} will stop unless somebody actively edits.`}
          values={{ ago: <TimeAgo date={date} />, projectLabelLower }}
        />
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
    return (
      <RestartProject
        size={isFlyout ? "small" : "large"}
        project_id={project_id}
        disabled={!commands.includes("start") && !commands.includes("stop")}
      />
    );
  }

  function render_action_buttons(): Rendered {
    const state = displayStateValue;
    const commands = (state &&
      COMPUTE_STATES[state] &&
      COMPUTE_STATES[state].commands) || ["save", "stop", "start"];
    return (
      <Space.Compact
        style={{ marginTop: "10px", marginBottom: "10px" }}
        size={isFlyout ? "small" : "large"}
      >
        {render_restart_button(commands)}
        {render_stop_button(commands)}
        <CloneProject project_id={project_id} />
        <MoveProject
          project_id={project_id}
          disabled={state == "starting" || state == "stopping"}
        />
      </Space.Compact>
    );
  }

  function render_idle_timeout_row() {
    if (displayStateValue !== "running") {
      return;
    }
    if (redux.getStore("projects").is_always_running(project_id)) {
      return (
        <LabeledRow
          key="idle-timeout"
          label={intl.formatMessage(labels.always_running)}
          style={rowStyle()}
          vertical={isFlyout}
        >
          <Paragraph>
            <FormattedMessage
              id="project.settings.control.idle_timeout.always_running.info"
              defaultMessage={`{projectLabel} will be <b>automatically started</b> if it stops
                for any reason (it will run any <A>init scripts</A>).`}
              values={{
                projectLabel,
                A: (c) => (
                  <A href="https://doc.cocalc.com/project-init.html">{c}</A>
                ),
              }}
            />
          </Paragraph>
        </LabeledRow>
      );
    }
    return (
      <LabeledRow
        key="idle-timeout"
        label={intl.formatMessage(labels.idle_timeout)}
        style={rowStyle()}
        vertical={isFlyout}
      >
        {render_idle_timeout()}
      </LabeledRow>
    );
  }

  function render_uptime() {
    // start_ts is a timestamp, e.g. 1508576664416
    const start_ts = project.getIn(["status", "start_ts"]);
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
    const cpu = project.getIn(["status", "cpu", "usage"]);
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

  function renderBody() {
    return (
      <>
        <div>
          {render_action_buttons()}
          <ProjectControlError
            style={{ margin: "10px 0px" }}
            showStopButton={project.getIn(["state", "state"]) == "running"}
          />
          <BootLog />
        </div>
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
        {render_idle_timeout_row()}
        {render_uptime()}
        {render_cpu_usage()}
        <hr />
        <LabeledRow
          key="root_fs"
          label="Root Filesystem Image"
          vertical={isFlyout}
        >
          <RootFilesystemImage />
        </LabeledRow>
      </>
    );
  }

  if (mode === "flyout") {
    return renderBody();
  } else {
    return (
      <SettingBox title={`${projectLabel} Control`} icon="gears">
        {renderBody()}
      </SettingBox>
    );
  }
};
