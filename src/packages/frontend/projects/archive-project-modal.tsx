/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Space } from "antd";
import { useState, type CSSProperties } from "react";
import { useIntl } from "react-intl";

import { alert_message } from "@cocalc/frontend/alerts";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";

import { IconBadge, InfoRow, InfoSection } from "./hard-delete-project-modal";

export interface ArchiveProjectModalItem {
  project_id: string;
  title?: string | null;
  state?: string | null;
  archiveAllowedByAdminOnly?: boolean;
}

interface Props {
  open: boolean;
  projects: ArchiveProjectModalItem[];
  skippedCount?: number;
  onCancel: () => void;
  onArchive: (project_ids: string[]) => Promise<void>;
}

export function ArchiveProjectModal({
  open,
  projects,
  skippedCount = 0,
  onCancel,
  onArchive,
}: Readonly<Props>) {
  const intl = useIntl();
  const projectLabelLower = intl.formatMessage(labels.project).toLowerCase();
  const projectsLabelLower = intl.formatMessage(labels.projects).toLowerCase();
  const projectIds = projects.map(({ project_id }) => project_id);
  const projectCount = projects.length;
  const single = projectCount === 1;
  const runningCount = projects.filter(({ state }) =>
    ["running", "starting"].includes(`${state ?? ""}`),
  ).length;
  const adminOnlyCount = projects.filter(
    ({ archiveAllowedByAdminOnly }) => archiveAllowedByAdminOnly === true,
  ).length;
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState("");

  function close() {
    if (archiving) return;
    setError("");
    onCancel();
  }

  async function archive() {
    setArchiving(true);
    setError("");
    onCancel();
    try {
      await onArchive(projectIds);
    } catch (err) {
      alert_message({
        type: "error",
        message: single
          ? `Unable to archive ${projectLabelLower}: ${err}`
          : `Unable to archive selected ${projectsLabelLower}: ${err}`,
      });
    } finally {
      setArchiving(false);
    }
  }

  const runningText =
    runningCount === 0
      ? single
        ? `This ${projectLabelLower} is not running, so CoCalc can usually archive it without starting it.`
        : `None of these ${projectsLabelLower} appear to be running, so CoCalc can usually archive them without starting them.`
      : runningCount === projectCount
        ? single
          ? `This ${projectLabelLower} is running, so CoCalc will stop it before making the final backup.`
          : `All selected ${projectsLabelLower} are running or starting, so CoCalc will stop them before making final backups.`
        : `${runningCount} selected ${projectsLabelLower} are running or starting, so CoCalc will stop those before making final backups.`;

  return (
    <Modal
      open={open}
      width={600}
      title={
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <IconBadge icon="file-archive" tone="positive" />
          <div>
            <div>
              Archive{" "}
              {single
                ? projectLabelLower
                : `${projectCount} ${projectsLabelLower}`}
            </div>
            <div style={SUBTITLE_STYLE}>
              Free active storage while keeping files recoverable.
            </div>
          </div>
        </div>
      }
      onCancel={close}
      footer={[
        <Button key="cancel" disabled={archiving} onClick={close}>
          {intl.formatMessage(labels.cancel)}
        </Button>,
        <Button
          key="archive"
          type="primary"
          loading={archiving}
          disabled={projectIds.length === 0 || archiving}
          onClick={() => {
            void archive();
          }}
        >
          <Icon name="file-archive" />{" "}
          {single ? "Archive Project" : "Archive Projects"}
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? (
          <Alert
            type="error"
            showIcon
            message={
              single
                ? `Unable to archive ${projectLabelLower}`
                : `Unable to archive selected ${projectsLabelLower}`
            }
            description={error}
          />
        ) : undefined}
        <div style={INTRO_STYLE}>
          Archiving is the low-cost, reversible way to put{" "}
          {single ? `this ${projectLabelLower}` : `these ${projectsLabelLower}`}{" "}
          away when you do not need active compute.
        </div>
        {adminOnlyCount > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={
              single
                ? `Archive is available because you are an administrator`
                : `${adminOnlyCount} selected ${projectsLabelLower} can be archived because you are an administrator`
            }
            description={
              single
                ? `The owner has not enabled Storage history for collaborators on this ${projectLabelLower}.`
                : `The owner has not enabled Storage history for collaborators on ${
                    adminOnlyCount === 1
                      ? `one selected ${projectLabelLower}`
                      : `${adminOnlyCount} selected ${projectsLabelLower}`
                  }.`
            }
          />
        ) : undefined}
        <InfoSection
          icon="check-circle"
          tone="positive"
          title="Why archive"
          plainIcon
        >
          <InfoRow icon="hdd">
            Frees active project-host storage and compute resources.
          </InfoRow>
          <InfoRow icon="compress">
            Keeps CoCalc storage costs low, which helps keep projects available
            long-term.
          </InfoRow>
          <InfoRow icon="cloud">
            Keeps the {single ? projectLabelLower : projectsLabelLower}{" "}
            recoverable from backup when you need access again.
          </InfoRow>
        </InfoSection>
        <InfoSection
          icon="file-archive"
          tone="positive"
          title="What CoCalc will do"
          plainIcon
        >
          <InfoRow icon="stop">{runningText}</InfoRow>
          <InfoRow icon="database">
            Create a final backup first if the latest backup is older than the
            latest edits.
          </InfoRow>
          <InfoRow icon="history">
            Remove the active host copy and filesystem snapshots; backups are
            kept so the {single ? projectLabelLower : projectsLabelLower} can be
            restored later.
          </InfoRow>
          <InfoRow icon="clock">
            Starting later restores from backup, so it can take longer than
            starting an active {projectLabelLower}.
          </InfoRow>
        </InfoSection>
        {projectCount > 1 ? <ProjectList projects={projects} /> : undefined}
        {skippedCount > 0 ? (
          <Alert
            type="info"
            showIcon
            message={`${skippedCount} selected ${projectsLabelLower} will be skipped`}
            description="Skipped projects are already archived, busy, or you do not have permission to archive them."
          />
        ) : undefined}
      </Space>
    </Modal>
  );
}

function ProjectList({
  projects,
}: {
  projects: readonly ArchiveProjectModalItem[];
}) {
  const shown = projects.slice(0, 6);
  const hiddenCount = projects.length - shown.length;
  return (
    <div style={PROJECTS_STYLE}>
      <div style={{ color: COLORS.GRAY_D, fontWeight: 600, marginBottom: 8 }}>
        Selected projects
      </div>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        {shown.map((project) => (
          <div key={project.project_id} style={PROJECT_ROW_STYLE}>
            <Icon name="project-outlined" style={{ color: COLORS.GRAY_M }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {`${project.title ?? ""}`.trim() || project.project_id}
            </span>
          </div>
        ))}
      </Space>
      {hiddenCount > 0 ? (
        <div style={{ color: COLORS.GRAY_M, marginTop: 6 }}>
          and {hiddenCount} more
        </div>
      ) : undefined}
    </div>
  );
}

const SUBTITLE_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
  fontSize: 13,
  fontWeight: 400,
  marginTop: 2,
};

const INTRO_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
};

const PROJECTS_STYLE: CSSProperties = {
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 10,
  padding: 12,
};

const PROJECT_ROW_STYLE: CSSProperties = {
  alignItems: "center",
  color: COLORS.GRAY_D,
  display: "grid",
  gap: 8,
  gridTemplateColumns: "20px minmax(0, 1fr)",
};
