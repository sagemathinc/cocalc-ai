/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Progress, Space } from "antd";
import { useState } from "react";
import { useIntl } from "react-intl";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { LroEvent } from "@cocalc/conat/hub/api/lro";

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
        title={`Permanently delete ${projectLabelLower}`}
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
            Permanently Delete
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
          <Alert
            showIcon
            type="error"
            message="This cannot be undone"
            description={`Deleting this ${projectLabelLower} permanently removes its files, collaborators, invitations, shares, project secrets, API keys, and metadata. Backups are cleaned up asynchronously and this ${projectLabelLower} cannot be opened or started after deletion begins.`}
          />
          <div>
            Type <code style={{ userSelect: "all" }}>{confirmationTarget}</code>{" "}
            to confirm.
          </div>
          <Input
            value={confirmation}
            disabled={deleting}
            placeholder={confirmationTarget}
            onChange={(e) => setConfirmation(e.target.value)}
            onPressEnter={() => {
              if (confirmationMatches && !deleting) {
                void permanentlyDeleteProject().catch((err) =>
                  setError(`${err}`),
                );
              }
            }}
          />
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
