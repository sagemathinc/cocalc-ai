/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The main purpose of this component is to provide a big start button that users
use to start this project. When the project is fully up and running this
component is invisible.

It's really more than just that button, since it gives info as starting/stopping
happens, and also when the system is heavily loaded.
*/

import { Alert, Button, Modal, Progress, Space, Spin } from "antd";
import type { ButtonProps } from "antd";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { redux, useMemo, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, ProjectState, Tooltip } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { capitalize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { useProjectContext } from "./context";
import { lite } from "@cocalc/frontend/lite";
import type { StartLroState } from "./start-ops";
import type { MoveLroState } from "./move-ops";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  hostLabel,
  normalizeProjectStateForDisplay,
} from "@cocalc/frontend/projects/host-operational";
import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import MoveProject from "@cocalc/frontend/project/settings/move-project";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  formatProgressDetail,
  clampProgressPercent,
} from "./explorer/lro-timeline-utils";
import { progressBarStatus } from "@cocalc/frontend/lro/utils";
import { useProjectActiveOperation } from "./use-project-active-op";
import {
  extractRuntimeSponsorDenial,
  formatRuntimeSponsorDenial,
  type RuntimeSponsorDenial,
} from "@cocalc/util/runtime-sponsor-denial";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import {
  formatProjectStartPolicyBlock,
  getProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

const STYLE: CSSProperties = {
  fontSize: "40px",
  textAlign: "center",
  color: COLORS.GRAY_M,
} as const;

export function StartButton({
  minimal,
  style,
  project_id: projectIdProp,
  size,
  danger,
  disabled,
}: {
  minimal?: boolean;
  style?: CSSProperties;
  project_id?: string;
  size?: ButtonProps["size"];
  danger?: boolean;
  disabled?: boolean;
}) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const { project_id: contextProjectId, is_active } = useProjectContext();
  const project_id = projectIdProp ?? contextProjectId;
  const resolvedProjectId = project_id ?? "";
  const project_map = useTypedRedux("projects", "project_map");
  const project = project_map?.get(resolvedProjectId);
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const host_id = project_map?.get(resolvedProjectId)?.get("host_id") as
    | string
    | undefined;
  const startPolicyBlock = useMemo(
    () =>
      getProjectStartPolicyBlock({
        project,
        account_id,
        is_admin: isAdmin,
        autostart: false,
      }),
    [project, account_id, isAdmin],
  );
  const hostInfo = useHostInfo(host_id);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  const hostUnavailable = !!host_id && hostOperational.state === "unavailable";
  const hostUnavailableReason =
    hostOperational.reason ?? "Assigned host is unavailable.";
  const assignedHostLabel = hostLabel(hostInfo, host_id);
  const lastNotRunningRef = useRef<null | number>(null);
  const startLroRecord = useTypedRedux(
    { project_id: resolvedProjectId },
    "start_lro",
  );
  const moveLroRecord = useTypedRedux(
    { project_id: resolvedProjectId },
    "move_lro",
  );
  const startLro = useMemo(
    () => startLroRecord?.toJS() as StartLroState | undefined,
    [startLroRecord],
  );
  const moveLro = useMemo(
    () => moveLroRecord?.toJS() as MoveLroState | undefined,
    [moveLroRecord],
  );
  const startLroActive =
    startLro != null &&
    (!startLro.summary ||
      startLro.summary.status === "queued" ||
      startLro.summary.status === "running");
  const startLroSummary = startLro?.summary;
  const startLroError = `${startLroSummary?.error ?? ""}`.trim();
  const runtimeSponsorDenial = startLroSummary?.result
    ?.runtime_sponsor_denial as RuntimeSponsorDenial | undefined;
  const startFailed = startLroSummary?.status === "failed" && !!startLroError;
  const minimalStartAttemptOpIdsRef = useRef<Set<string>>(new Set());
  const moveActive =
    moveLro != null &&
    (!moveLro.summary ||
      moveLro.summary.status === "queued" ||
      moveLro.summary.status === "running");

  const state = useMemo(() => {
    const rawState = project_map?.get(resolvedProjectId)?.get("state");
    const displayState = normalizeProjectStateForDisplay({
      projectState: rawState?.get?.("state"),
      hostId: host_id,
      hostInfo,
    });
    const state =
      rawState != null && displayState && rawState.get("state") !== displayState
        ? rawState.set("state", displayState)
        : rawState;
    if (state != null) {
      lastNotRunningRef.current =
        state.get("state") === "running" ? null : Date.now();
    }
    return state;
  }, [project_map, resolvedProjectId, host_id, hostInfo]);
  const lifecycleState = `${state?.get("state") ?? ""}`.trim().toLowerCase();
  const { activeOp } = useProjectActiveOperation(resolvedProjectId, {
    pollWhile:
      is_active &&
      (startLroActive ||
        lifecycleState === "starting" ||
        lifecycleState === "opening"),
  });
  const activeOpStartLike =
    activeOp?.kind === "project-start" &&
    (activeOp.status === "queued" || activeOp.status === "running");

  const starting = useMemo(() => {
    if (lifecycleState === "starting" || lifecycleState === "opening")
      return true;
    if (lifecycleState === "running") return false;
    return startLroActive || activeOpStartLike;
  }, [activeOpStartLike, lifecycleState, startLroActive]);

  useEffect(() => {
    if (!minimal || !startFailed || !startLroSummary || !project_id) return;
    if (!minimalStartAttemptOpIdsRef.current.has(startLroSummary.op_id)) {
      return;
    }
    minimalStartAttemptOpIdsRef.current.delete(startLroSummary.op_id);
    Modal.error({
      title: "Project start failed",
      content: renderStartFailureDescription(),
      okText: "Close",
      width: 720,
    });
  }, [
    minimal,
    project_id,
    runtimeSponsorDenial,
    startFailed,
    startLroError,
    startLroSummary,
  ]);

  if (!project_id) {
    return null;
  }

  // in lite mode cocalc *is* being served directly from the project so it makes no sense
  // to start or stop the project.
  if (lite || state?.get("state") === "running") {
    return null;
  }

  if (minimal && hostUnavailable) {
    return null;
  }

  function renderStartFailureDescription() {
    return runtimeSponsorDenial ? (
      <RuntimeSponsorDenialDescription
        denial={runtimeSponsorDenial}
        project_id={resolvedProjectId}
      />
    ) : (
      startLroError
    );
  }

  function renderStartErrorDescription(err: unknown) {
    const denial = extractRuntimeSponsorDenial(err);
    return denial ? (
      <RuntimeSponsorDenialDescription
        denial={denial}
        project_id={resolvedProjectId}
      />
    ) : err instanceof Error ? (
      err.message
    ) : startPolicyBlock ? (
      formatProjectStartPolicyBlock(startPolicyBlock)
    ) : (
      `${err}`
    );
  }

  function showStartError(err: unknown) {
    Modal.error({
      title: "Unable to start project",
      content: renderStartErrorDescription(err),
      width: extractRuntimeSponsorDenial(err) ? 720 : undefined,
    });
  }

  async function requestProjectStart() {
    await redux.getActions("projects").start_project(project_id, {
      onStartOp: (op) => {
        if (minimal && op.op_id) {
          minimalStartAttemptOpIdsRef.current.add(op.op_id);
        }
      },
    });
  }

  function render_start_project_button() {
    const enabled =
      state == null ||
      !state?.get("state") ||
      (!hostUnavailable &&
        ["opened", "closed", "archived"].includes(state?.get("state")));

    const txt = intl.formatMessage(
      {
        id: "project.start-button.button.txt",
        defaultMessage: `{starting, select, true {Starting {projectLabel}} other {Start {projectLabel}}}`,
        description:
          "Label on a button, either to start the project or indicating the project is currently starting.",
      },
      { starting, projectLabel },
    );

    const compactTxt = intl.formatMessage(
      {
        id: "project.start-button.button.compact.txt",
        defaultMessage: `{starting, select, true {Starting} other {Start}}`,
        description:
          "Compact label on a project start button in a project tab bar.",
      },
      { starting },
    );

    const startProject = async () => {
      if (startPolicyBlock?.code === "collaborator_sponsor_disabled") {
        Modal.confirm({
          title: "Use your membership to start this project?",
          content: (
            <div>
              <p>{startPolicyBlock.message}</p>
              <p style={{ marginBottom: 0 }}>{startPolicyBlock.action}</p>
            </div>
          ),
          okText: "Use my membership and start",
          cancelText: "Cancel",
          onOk: async () => {
            try {
              await redux
                .getActions("projects")
                .set_project_runtime_sponsor_to_me(project_id);
              await requestProjectStart();
            } catch (err) {
              showStartError(err);
            }
          },
        });
        return;
      }
      try {
        await requestProjectStart();
      } catch (err) {
        showStartError(err);
      }
    };

    if (minimal) {
      return (
        <Button
          type="primary"
          size={size}
          style={{
            ...style,
            width: "112px",
            whiteSpace: "nowrap",
          }}
          title={
            starting ? `${projectLabel} is starting` : `Start ${projectLabel}`
          }
          danger={danger}
          disabled={starting || !enabled || disabled}
          onClick={startProject}
        >
          <Space size={6}>
            {starting ? <Icon name="cocalc-ring" spin /> : <Icon name="play" />}
            {compactTxt}
          </Space>
        </Button>
      );
    }

    const membership_hint = `This ${projectLabel.toLowerCase()} will start with the upgrades that your membership level provides.`;

    return (
      <div>
        <Space size="small" align="center">
          <Tooltip
            title={
              <div>
                <ProjectState state={state} show_desc={true} />
                <div style={{ fontSize: "12px", color: "#fff" }}>
                  {membership_hint}
                </div>
                {hostUnavailable && (
                  <div style={{ fontSize: "12px", color: "#fff" }}>
                    Host unavailable: {hostUnavailableReason}
                  </div>
                )}
              </div>
            }
          >
            <Button
              type="primary"
              size={size ?? "large"}
              danger={danger}
              disabled={!enabled || disabled}
              onClick={startProject}
            >
              <Space>
                {starting ? (
                  <Icon name="cocalc-ring" spin />
                ) : (
                  <Icon name="play" />
                )}
                {txt}
              </Space>
            </Button>
          </Tooltip>
          {moveActive && moveLro && <MoveProgressInline moveLro={moveLro} />}
        </Space>
        {starting && startLro && <StartProgressInline startLro={startLro} />}
        {startFailed && startLroSummary && (
          <Alert
            style={{ marginTop: "10px", maxWidth: "720px" }}
            type="error"
            showIcon
            title="Project start failed"
            description={renderStartFailureDescription()}
            action={
              <Button
                size="small"
                onClick={async () => {
                  await webapp_client.conat_client.hub.lro.dismiss({
                    op_id: startLroSummary.op_id,
                  });
                }}
              >
                Dismiss
              </Button>
            }
          />
        )}
      </div>
    );
  }

  if (minimal) {
    return render_start_project_button();
  }

  // In case user is admin viewing another user's project, we provide a
  // special mode.
  function render_admin_view() {
    return (
      <Alert
        banner={true}
        type="error"
        title="Admin Project View"
        description={
          <>
            WARNING: You are viewing this project as an admin! (1) Some things
            won't work. (2) Be <b>VERY careful</b> opening any files, since this
            is a dangerous attack vector.
          </>
        }
      />
    );
  }

  function render_normal_view() {
    if (hostUnavailable) {
      return (
        <Alert
          banner={true}
          showIcon={false}
          title={
            <>
              <span
                style={{
                  fontSize: "20pt",
                  color: COLORS.GRAY_D,
                }}
              >
                {assignedHostLabel} is unavailable
              </span>
              <div
                style={{
                  marginTop: "8px",
                  fontSize: "12px",
                  color: COLORS.GRAY_D,
                }}
              >
                This {projectLabel.toLowerCase()} is assigned to{" "}
                {assignedHostLabel} ({hostUnavailableReason}). Wait for this
                host to come online, or move this {projectLabel.toLowerCase()}{" "}
                to an available host.
              </div>
              <div style={{ marginTop: "10px" }}>
                <MoveProject
                  project_id={project_id}
                  size="large"
                  label="Move Project"
                  showHostName={false}
                />
              </div>
            </>
          }
          type="warning"
        />
      );
    }

    return (
      <Alert
        banner={true}
        showIcon={false}
        title={
          <>
            <span
              style={{
                fontSize: "20pt",
                color: COLORS.GRAY_D,
              }}
            >
              <ProjectState state={state} show_desc={true} />
            </span>
            <div>{render_start_project_button()}</div>
            {hostUnavailable && (
              <div
                style={{
                  marginTop: "8px",
                  fontSize: "12px",
                  color: COLORS.GRAY_D,
                }}
              >
                {assignedHostLabel} is unavailable ({hostUnavailableReason}).
                Open Settings and move this project to an available host, or
                start the assigned host.
              </div>
            )}
          </>
        }
        type="info"
      />
    );
  }

  return (
    <div style={{ ...STYLE, ...style }}>
      {state == null && redux.getStore("account")?.get("is_admin")
        ? render_admin_view()
        : render_normal_view()}
    </div>
  );
}

const START_PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  apply_pending_copies: "Preparing project state",
  prepare_config: "Preparing runtime",
  cache_rootfs: "Pulling RootFS image",
  "start-project": "Starting runtime",
  runner_start: "Starting runtime",
  refresh_authorized_keys: "Refreshing access",
  done: "Project ready",
  failed: "Start failed",
};

function StartProgressInline({ startLro }: { startLro: StartLroState }) {
  const phase =
    `${startLro.last_progress?.phase ?? startLro.summary?.progress_summary?.phase ?? ""}`
      .trim()
      .toLowerCase() || "queued";
  const phaseLabel = START_PHASE_LABELS[phase] ?? capitalize(phase);
  const rawMessage = `${
    startLro.last_progress?.message ??
    startLro.summary?.progress_summary?.message ??
    ""
  }`.trim();
  const detailText = formatProgressDetail(
    startLro.last_progress?.detail ??
      startLro.summary?.progress_summary?.detail,
  );
  const percent =
    clampProgressPercent(startLro.last_progress?.progress) ??
    clampProgressPercent(startLro.summary?.progress_summary?.progress);
  const status = startLro.summary?.status;
  const message =
    rawMessage && rawMessage.toLowerCase() !== phase
      ? `${phaseLabel}: ${rawMessage}`
      : phaseLabel;

  return (
    <div style={{ marginTop: "6px" }}>
      <Space size="small" align="center" wrap>
        <span style={{ fontSize: "11px", color: COLORS.GRAY_M }}>
          {message}
          {detailText ? ` · ${detailText}` : ""}
        </span>
        {percent == null ? (
          <Spin size="small" />
        ) : (
          <Progress
            percent={percent}
            size="small"
            showInfo={false}
            status={progressBarStatus(status)}
            style={{ width: "180px" }}
          />
        )}
      </Space>
    </div>
  );
}

function MoveProgressInline({ moveLro }: { moveLro: MoveLroState }) {
  const phaseMessage =
    moveLro.summary?.progress_summary?.phase ??
    moveLro.last_progress?.phase ??
    moveLro.last_progress?.message ??
    "Moving project";
  const progress = moveLro.last_progress?.progress;
  const percent =
    progress == null
      ? undefined
      : Math.max(0, Math.min(100, Math.round(progress)));
  const status = moveLro.summary?.status;

  return (
    <Space size="small" align="center">
      <span style={{ fontSize: "11px", color: COLORS.GRAY_M }}>
        {phaseMessage}
      </span>
      {percent == null ? (
        <Spin size="small" />
      ) : (
        <Progress
          percent={percent}
          size="small"
          showInfo={false}
          status={
            status === "failed" || status === "canceled" || status === "expired"
              ? "exception"
              : status === "succeeded"
                ? "success"
                : "active"
          }
          style={{ width: "120px" }}
        />
      )}
    </Space>
  );
}

function RuntimeSponsorDenialDescription({
  denial,
  project_id,
}: {
  denial: RuntimeSponsorDenial;
  project_id: string;
}) {
  const [stoppingProjectIds, setStoppingProjectIds] = useState<
    Record<string, true>
  >({});
  const [changingSponsor, setChangingSponsor] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [stopError, setStopError] = useState<string>("");
  const visibleProjects = denial.active_projects.filter(
    (project) => project.visible !== false,
  );
  const nonCollaboratorCount =
    denial.active_projects.length - visibleProjects.length;
  const canStopAnyVisibleProject = visibleProjects.some(
    (project) => project.can_stop !== false,
  );

  async function stopProjectAndRetry(projectToStopId: string) {
    setStopError("");
    setStoppingProjectIds((ids) => ({ ...ids, [projectToStopId]: true }));
    try {
      await redux.getActions("projects").stop_project(projectToStopId);
      await redux.getActions("projects").start_project(project_id);
    } catch (err) {
      setStopError(`${err}`);
    } finally {
      setStoppingProjectIds((ids) => {
        const next = { ...ids };
        delete next[projectToStopId];
        return next;
      });
    }
  }

  async function useMyMembershipAndRetry() {
    setStopError("");
    setChangingSponsor(true);
    try {
      await redux
        .getActions("projects")
        .set_project_runtime_sponsor_to_me(project_id);
      await redux.getActions("projects").start_project(project_id);
    } catch (err) {
      setStopError(`${err}`);
    } finally {
      setChangingSponsor(false);
    }
  }

  function openMembershipDetails() {
    setMembershipOpen(true);
  }

  return (
    <div>
      <div>{formatRuntimeSponsorDenial(denial)}</div>
      {visibleProjects.length > 0 && (
        <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
          {visibleProjects.map((project) => (
            <li key={project.project_id}>
              <Space size="small" align="center" wrap>
                {project.can_stop !== false && (
                  <Button
                    size="small"
                    loading={!!stoppingProjectIds[project.project_id]}
                    onClick={() => stopProjectAndRetry(project.project_id)}
                  >
                    Stop
                  </Button>
                )}
                <ProjectTitle project_id={project.project_id} trunc={60} />
                {project.state && <span>({project.state})</span>}
              </Space>
            </li>
          ))}
        </ul>
      )}
      {canStopAnyVisibleProject && (
        <div style={{ marginTop: "8px" }}>
          Stop one of these projects to free a running-project slot and start
          the project you were trying to start.
        </div>
      )}
      {denial.can_upgrade && (
        <div style={{ marginTop: "8px" }}>
          <Button size="small" onClick={openMembershipDetails}>
            Open membership details
          </Button>
        </div>
      )}
      {denial.can_change_sponsor && (
        <div style={{ marginTop: "8px" }}>
          <Button
            size="small"
            loading={changingSponsor}
            onClick={useMyMembershipAndRetry}
          >
            Use my membership and try again
          </Button>
        </div>
      )}
      {stopError && (
        <div style={{ marginTop: "8px", color: COLORS.ANTD_RED_WARN }}>
          Runtime sponsor action failed: {stopError}
        </div>
      )}
      {nonCollaboratorCount > 0 && (
        <div style={{ marginTop: "8px" }}>
          {nonCollaboratorCount} sponsored running{" "}
          {nonCollaboratorCount === 1 ? "project is" : "projects are"} not shown
          here because your account is not a collaborator.
        </div>
      )}
      <MembershipPurchaseModal
        open={membershipOpen}
        onClose={() => setMembershipOpen(false)}
      />
    </div>
  );
}
