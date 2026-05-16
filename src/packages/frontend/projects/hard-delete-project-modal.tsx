/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Progress, Space } from "antd";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useIntl } from "react-intl";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, type IconName } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  open: boolean;
  project_id: string;
  title?: string | null;
  name?: string | null;
  onCancel: () => void;
  onDeleted?: () => void;
}

export function HardDeleteProjectModal({
  open,
  project_id,
  title,
  name,
  onCancel,
  onDeleted,
}: Readonly<Props>) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectTitle = `${title ?? ""}`.trim();
  const projectName = `${name ?? ""}`.trim();
  const confirmationTarget = projectTitle || projectName || project_id;
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<
    Extract<LroEvent, { type: "progress" }> | undefined
  >();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  function close() {
    if (deleting) return;
    setConfirmation("");
    setProgress(undefined);
    setError("");
    onCancel();
  }

  async function permanentlyDeleteProject(): Promise<void> {
    setError("");
    const action = async () => {
      setDeleting(true);
      setProgress(undefined);
      try {
        const op =
          await webapp_client.conat_client.hub.projects.hardDeleteProject({
            project_id,
            browser_id: webapp_client.browser_id,
          });
        const summary = await webapp_client.conat_client.lroWait({
          op_id: op.op_id,
          stream_name: op.stream_name,
          scope_type: op.scope_type,
          scope_id: op.scope_id,
          onProgress: setProgress,
        });
        if (summary.status !== "succeeded") {
          throw new Error(summary.error ?? `project delete ${summary.status}`);
        }
        setConfirmation("");
        setProgress(undefined);
        onDeleted?.();
        onCancel();
      } finally {
        setDeleting(false);
      }
    };
    const accepted = await runFreshAuthAction(action);
    if (!accepted) {
      setDeleting(false);
    }
  }

  const confirmationMatches =
    confirmation.trim() === confirmationTarget ||
    confirmation.trim() === project_id;
  const progressPhase = progress?.phase ?? progress?.message;
  const progressPercent =
    progress?.progress == null
      ? undefined
      : Math.max(0, Math.min(100, Math.round(progress.progress)));

  return (
    <>
      <Modal
        open={open}
        width={560}
        title={
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <IconBadge icon="trash" tone="danger" />
            <div>
              <div>Permanently delete {projectLabelLower}</div>
              <div
                style={{
                  color: COLORS.GRAY_M,
                  fontSize: 13,
                  fontWeight: 400,
                  marginTop: 2,
                }}
              >
                This cannot be undone.
              </div>
            </div>
          </div>
        }
        onCancel={close}
        footer={[
          <Button key="cancel" disabled={deleting} onClick={close}>
            {intl.formatMessage(labels.cancel)}
          </Button>,
          <Button
            key="delete"
            danger
            type="primary"
            loading={deleting}
            disabled={!confirmationMatches || deleting}
            onClick={() => {
              void permanentlyDeleteProject().catch((err) =>
                setError(`${err}`),
              );
            }}
          >
            Permanently Delete Project
          </Button>,
        ]}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {error ? (
            <Alert
              type="error"
              showIcon
              message="Unable to delete project"
              description={error}
            />
          ) : undefined}
          <div style={{ color: COLORS.GRAY_M }}>
            Review exactly what will be removed before confirming.
          </div>
          <InfoSection
            icon="warning"
            tone="danger"
            title="What will be deleted"
          >
            <InfoRow icon="file">Files, folders, and project metadata</InfoRow>
            <InfoRow icon="users">
              Collaborator access, invitations, and shares
            </InfoRow>
            <InfoRow icon="key">Project secrets and SSH keys</InfoRow>
            <InfoRow icon="history">
              All TimeTravel edit history for every document
            </InfoRow>
          </InfoSection>
          <InfoSection
            icon="check-circle"
            tone="positive"
            title="What this cleans up"
          >
            <InfoRow icon="project-outlined">
              Immediately frees one of your project slots
            </InfoRow>
            <InfoRow icon="hdd">
              Frees the storage used by this {projectLabelLower} as cleanup runs
            </InfoRow>
            <InfoRow icon="lock">
              Deletes all backups soon, reducing retained private data
            </InfoRow>
          </InfoSection>
          <div
            style={{
              background: COLORS.GRAY_LLL,
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
              Type{" "}
              <code style={{ userSelect: "all" }}>
                &quot;{confirmationTarget}&quot;
              </code>{" "}
              to confirm.
            </div>
            <div style={{ color: COLORS.GRAY_M, marginTop: 4 }}>
              After deletion begins, this {projectLabelLower} cannot be opened
              or started.
            </div>
            <Input
              value={confirmation}
              disabled={deleting}
              placeholder={confirmationTarget}
              style={{ marginTop: 10 }}
              onChange={(e) => setConfirmation(e.target.value)}
              onPressEnter={() => {
                if (confirmationMatches && !deleting) {
                  void permanentlyDeleteProject().catch((err) =>
                    setError(`${err}`),
                  );
                }
              }}
            />
          </div>
          {deleting ? (
            <div>
              <div style={{ marginBottom: 8 }}>
                {progressPhase ? `${progressPhase}` : "Deleting project..."}
              </div>
              <Progress percent={progressPercent ?? 0} status="active" />
            </div>
          ) : undefined}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

function IconBadge({
  icon,
  tone,
}: {
  icon: IconName;
  tone: "danger" | "positive";
}) {
  const style = tone === "danger" ? DANGER_BADGE_STYLE : POSITIVE_BADGE_STYLE;
  return (
    <span style={style}>
      <Icon name={icon} />
    </span>
  );
}

function InfoSection({
  icon,
  title,
  tone,
  children,
}: {
  icon: IconName;
  title: string;
  tone: "danger" | "positive";
  children: ReactNode;
}) {
  const sectionStyle =
    tone === "danger" ? DANGER_SECTION_STYLE : POSITIVE_SECTION_STYLE;
  const titleStyle =
    tone === "danger" ? DANGER_TITLE_STYLE : POSITIVE_TITLE_STYLE;
  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>
        <IconBadge icon={icon} tone={tone} />
        {title}
      </div>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {children}
      </Space>
    </div>
  );
}

function InfoRow({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div
      style={{
        color: COLORS.GRAY_D,
        display: "grid",
        gap: 8,
        gridTemplateColumns: "20px minmax(0, 1fr)",
        alignItems: "start",
      }}
    >
      <Icon name={icon} style={{ color: COLORS.GRAY_M, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

const BADGE_STYLE: CSSProperties = {
  borderRadius: "50%",
  display: "inline-grid",
  height: 32,
  placeItems: "center",
  width: 32,
};

const DANGER_BADGE_STYLE: CSSProperties = {
  ...BADGE_STYLE,
  background: COLORS.ANTD_BG_RED_L,
  color: COLORS.FG_RED,
};

const POSITIVE_BADGE_STYLE: CSSProperties = {
  ...BADGE_STYLE,
  background: COLORS.YELL_LLL,
  color: COLORS.BRWN,
};

const SECTION_STYLE: CSSProperties = {
  borderRadius: 10,
  padding: 14,
};

const DANGER_SECTION_STYLE: CSSProperties = {
  ...SECTION_STYLE,
  background: "white",
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderLeft: `4px solid ${COLORS.FG_RED}`,
};

const POSITIVE_SECTION_STYLE: CSSProperties = {
  ...SECTION_STYLE,
  background: COLORS.YELL_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
};

const TITLE_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  fontWeight: 700,
  gap: 10,
  marginBottom: 10,
};

const DANGER_TITLE_STYLE: CSSProperties = {
  ...TITLE_STYLE,
  color: COLORS.FG_RED,
};

const POSITIVE_TITLE_STYLE: CSSProperties = {
  ...TITLE_STYLE,
  color: COLORS.BRWN,
};
