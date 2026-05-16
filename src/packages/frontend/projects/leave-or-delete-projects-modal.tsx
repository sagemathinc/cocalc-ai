/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space } from "antd";
import { useState } from "react";

import { Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

import { IconBadge, InfoRow, InfoSection } from "./hard-delete-project-modal";

export type LeaveOrDeleteProjectsPlan = {
  deleteIds: string[];
  transferIds: string[];
  leaveIds: string[];
  skippedIds: string[];
  actionableIds: string[];
};

interface Props {
  open: boolean;
  plan: LeaveOrDeleteProjectsPlan;
  projectsLabelLower: string;
  projectTitle: (project_id: string) => string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

const CONFIRMATION_TEXT = "LEAVE OR DELETE";

export function LeaveOrDeleteProjectsModal({
  open,
  plan,
  projectsLabelLower,
  projectTitle,
  onCancel,
  onConfirm,
}: Readonly<Props>) {
  const [confirmation, setConfirmation] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const confirmationMatches = confirmation.trim() === CONFIRMATION_TEXT;
  const selectedCount =
    plan.deleteIds.length +
    plan.transferIds.length +
    plan.leaveIds.length +
    plan.skippedIds.length;

  function close() {
    if (processing) return;
    setConfirmation("");
    setError("");
    onCancel();
  }

  async function confirm() {
    if (!confirmationMatches || processing) return;
    setProcessing(true);
    setError("");
    try {
      await onConfirm();
      setConfirmation("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Modal
      open={open}
      width={620}
      title={
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <IconBadge icon="trash" tone="danger" />
          <div>
            <div>Leave or delete selected {projectsLabelLower}</div>
            <div
              style={{
                color: COLORS.GRAY_M,
                fontSize: 13,
                fontWeight: 400,
                marginTop: 2,
              }}
            >
              This may permanently delete projects you own.
            </div>
          </div>
        </div>
      }
      onCancel={close}
      footer={[
        <Button key="cancel" disabled={processing} onClick={close}>
          Cancel
        </Button>,
        <Button
          key="confirm"
          danger
          type="primary"
          loading={processing}
          disabled={!confirmationMatches || processing}
          onClick={() => {
            void confirm();
          }}
        >
          Leave or Delete Selected
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? (
          <Alert
            type="error"
            showIcon
            message="Unable to leave or delete projects"
            description={error}
          />
        ) : undefined}
        <div style={{ color: COLORS.GRAY_M }}>
          Review exactly what will happen to {selectedCount} selected{" "}
          {projectsLabelLower} before confirming.
        </div>
        <InfoSection
          icon="warning"
          tone="danger"
          title="What will happen"
          plainIcon
        >
          <InfoRow icon="trash">
            <strong>{plan.deleteIds.length}</strong> owned {projectsLabelLower}{" "}
            with no collaborators will be permanently deleted.
          </InfoRow>
          <InfoRow icon="exchange">
            <strong>{plan.transferIds.length}</strong> owned{" "}
            {projectsLabelLower} with collaborators will be transferred to the
            collaborator who most recently used the project, and you will be
            removed.
          </InfoRow>
          <InfoRow icon="user-times">
            <strong>{plan.leaveIds.length}</strong> {projectsLabelLower} you do
            not own will remove you as a collaborator.
          </InfoRow>
          {plan.skippedIds.length > 0 ? (
            <InfoRow icon="check-circle">
              <strong>{plan.skippedIds.length}</strong> selected{" "}
              {projectsLabelLower} will be skipped because they cannot be
              changed by this action.
            </InfoRow>
          ) : undefined}
        </InfoSection>
        {plan.deleteIds.length > 0 ? (
          <InfoSection
            icon="lock"
            tone="positive"
            title="Permanent deletion includes"
            plainIcon
          >
            <InfoRow icon="file">Files, folders, and project metadata</InfoRow>
            <InfoRow icon="users">
              Collaborator access, invitations, and shares
            </InfoRow>
            <InfoRow icon="key">Project secrets and SSH keys</InfoRow>
            <InfoRow icon="history">
              All TimeTravel edit history for every document
            </InfoRow>
            <InfoRow icon="hdd">
              All backups will be deleted soon, reducing retained private data
            </InfoRow>
          </InfoSection>
        ) : undefined}
        {plan.transferIds.length > 0 ? (
          <ProjectList
            title="Ownership will transfer for"
            project_ids={plan.transferIds}
            projectTitle={projectTitle}
          />
        ) : undefined}
        {plan.deleteIds.length > 0 ? (
          <ProjectList
            title="Will be permanently deleted"
            project_ids={plan.deleteIds}
            projectTitle={projectTitle}
          />
        ) : undefined}
        <div
          style={{
            background: COLORS.GRAY_LLL,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
            Type this exact text &quot;
            <code style={{ userSelect: "all" }}>{CONFIRMATION_TEXT}</code>
            &quot; to confirm.
          </div>
          <div style={{ color: COLORS.GRAY_M, marginTop: 4 }}>
            This is immediate for collaborator removal and starts irreversible
            cleanup for projects that are deleted.
          </div>
          <Input
            value={confirmation}
            disabled={processing}
            placeholder={CONFIRMATION_TEXT}
            style={{ marginTop: 10 }}
            onChange={(e) => setConfirmation(e.target.value)}
            onPressEnter={() => {
              void confirm();
            }}
          />
        </div>
      </Space>
    </Modal>
  );
}

function ProjectList({
  title,
  project_ids,
  projectTitle,
}: {
  title: string;
  project_ids: string[];
  projectTitle: (project_id: string) => string;
}) {
  return (
    <div
      style={{
        background: "white",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          alignItems: "center",
          color: COLORS.GRAY_D,
          display: "flex",
          fontWeight: 700,
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icon name="project-outlined" />
        {title}
      </div>
      <ul
        style={{
          color: COLORS.GRAY_D,
          margin: 0,
          maxHeight: 110,
          overflow: "auto",
          paddingLeft: 22,
        }}
      >
        {project_ids.map((project_id) => (
          <li key={project_id}>{projectTitle(project_id)}</li>
        ))}
      </ul>
    </div>
  );
}
