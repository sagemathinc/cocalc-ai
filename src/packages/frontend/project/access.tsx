/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Radio,
  Space,
  Typography,
} from "antd";
import type { ProjectAccessLandingInfo } from "@cocalc/conat/hub/api/projects";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Title, Text, Paragraph } = Typography;

export function ProjectAccessLandingPage({
  info,
  loading,
  error,
  onChange,
  embedded = false,
  onBack,
  backLabel = "Back to projects",
  onAccessGranted,
}: {
  info: ProjectAccessLandingInfo;
  loading: boolean;
  error: string | null;
  onChange: (info: ProjectAccessLandingInfo) => void;
  embedded?: boolean;
  onBack?: () => void;
  backLabel?: string;
  onAccessGranted?: () => Promise<void> | void;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const session = `${accountId}:${info.project_id}`;
  const active = useRef(session);
  active.current = session;
  useEffect(() => {
    active.current = session;
    return () => {
      active.current = "";
    };
  }, [session]);
  const [requestedRole, setRequestedRole] = useState<"viewer" | "collaborator">(
    info.relationship === "viewer" ? "collaborator" : "viewer",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const projectTitle = info.title?.trim() || "Untitled project";
  const owner = info.owner;
  const canChooseViewer = info.relationship !== "viewer";

  async function refreshProjectAccess() {
    await (
      redux.getActions("projects") as any
    )?.ensureRealtimeFeedForCurrentAccount?.();
    if (active.current !== session) return;
    if (onAccessGranted) {
      await onAccessGranted();
      return;
    }
    await redux.getActions("projects").open_project({
      project_id: info.project_id,
      target: "files",
      switch_to: true,
      restore_session: false,
    });
  }

  async function acceptInvite() {
    if (!info.pending_invite) return;
    setBusy(true);
    setActionError(null);
    try {
      await webapp_client.project_collaborators.respond_invite({
        invite_id: info.pending_invite.invite_id,
        project_id: info.project_id,
        action: "accept",
      });
      if (active.current !== session) return;
      await refreshProjectAccess();
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function declineInvite() {
    if (!info.pending_invite) return;
    setBusy(true);
    setActionError(null);
    try {
      await webapp_client.project_collaborators.respond_invite({
        invite_id: info.pending_invite.invite_id,
        project_id: info.project_id,
        action: "decline",
      });
      if (active.current !== session) return;
      const next =
        await webapp_client.project_collaborators.get_access_landing_info({
          project_id: info.project_id,
        });
      if (active.current === session) onChange(next);
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function requestAccess() {
    setBusy(true);
    setActionError(null);
    try {
      const request = await webapp_client.project_collaborators.request_access({
        project_id: info.project_id,
        requested_role: requestedRole,
        message,
        source:
          info.relationship === "viewer" ? "viewer-read-only" : "project-url",
      });
      if (active.current !== session) return;
      onChange({
        ...info,
        pending_request: {
          request_id: request.request_id,
          requested_role: request.requested_role,
          status: "pending",
        },
      });
      setMessage("");
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: embedded ? undefined : "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: embedded ? 0 : 24,
        background: embedded ? undefined : UI_COLORS.inset,
      }}
    >
      <Card
        variant={embedded ? "borderless" : undefined}
        style={{ width: "100%", maxWidth: 680 }}
        styles={embedded ? { body: { padding: 0 } } : undefined}
      >
        <Space vertical size="middle" style={{ width: "100%" }}>
          <div>
            {!embedded && (
              <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
                Project access
              </Title>
            )}
            <Text type="secondary">
              {info.relationship === "none"
                ? "You do not have access to this project."
                : info.relationship === "viewer"
                  ? "You have viewer access to this project."
                  : "You already have access to this project."}
            </Text>
          </div>
          <div
            style={{
              border: `1px solid ${UI_COLORS.border}`,
              borderRadius: 10,
              padding: 14,
              background: UI_COLORS.surface,
            }}
          >
            <Title level={4} style={{ marginTop: 0, overflowWrap: "anywhere" }}>
              {projectTitle}
            </Title>
            {owner != null && (
              <Space>
                <Avatar
                  account_id={owner.account_id}
                  display_name={owner.name ?? undefined}
                  first_name={owner.first_name ?? undefined}
                  last_name={owner.last_name ?? undefined}
                  size={32}
                />
                <span>
                  Owner:{" "}
                  <Text strong>
                    {displayNameFromAccount({
                      display_name: owner.name,
                      first_name: owner.first_name,
                      last_name: owner.last_name,
                    }) || "Unknown"}
                  </Text>
                </span>
              </Space>
            )}
          </div>
          {info.pending_invite != null ? (
            <Alert
              showIcon
              type="success"
              title={`You were invited as a ${info.pending_invite.invite_role}.`}
              description={
                <Space wrap style={{ marginTop: 8 }}>
                  <Button type="primary" loading={busy} onClick={acceptInvite}>
                    Accept invite
                  </Button>
                  <Button disabled={busy} onClick={declineInvite}>
                    Decline
                  </Button>
                </Space>
              }
            />
          ) : info.pending_request != null ? (
            <Alert
              showIcon
              type="info"
              title="Access request pending"
              description={`You requested ${info.pending_request.requested_role} access. A project owner or authorized collaborator can approve it.`}
            />
          ) : info.blocked ? (
            <Alert
              showIcon
              type="warning"
              title="Access requests are not available"
              description="This project is not accepting access requests from your account."
            />
          ) : info.relationship === "none" || info.relationship === "viewer" ? (
            <Space vertical size="middle" style={{ width: "100%" }}>
              <Paragraph style={{ marginBottom: 0 }}>
                Request access from the project owner or an authorized
                collaborator.
              </Paragraph>
              <Radio.Group
                aria-label="Requested access"
                value={requestedRole}
                onChange={(e) => setRequestedRole(e.target.value)}
              >
                {canChooseViewer && <Radio value="viewer">Viewer</Radio>}
                <Radio value="collaborator">Collaborator</Radio>
              </Radio.Group>
              <Input.TextArea
                aria-label="Optional message"
                rows={3}
                maxLength={512}
                showCount
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional short message"
              />
              <Button
                type="primary"
                loading={busy || loading}
                onClick={requestAccess}
              >
                Request access
              </Button>
            </Space>
          ) : null}
          {(error || actionError) && (
            <Alert
              showIcon
              type="error"
              title="Unable to update project access"
              description={actionError ?? error}
            />
          )}
          <Space>
            <Button
              onClick={() => {
                if (onBack) {
                  onBack();
                  return;
                }
                redux.getActions("page").close_project_tab(info.project_id);
                redux.getActions("page").set_active_tab("projects");
              }}
            >
              {backLabel}
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  );
}

/** The same invite/request workflow, without navigating away from its caller. */
export function ProjectAccessDialog({
  projectId,
  open,
  onClose,
  onAccessGranted,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onAccessGranted?: () => Promise<void> | void;
}) {
  const accountId = useTypedRedux("account", "account_id");
  return (
    <Modal
      open={open}
      title="Project access"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {open && (
        <KeyboardBoundary boundary="project-access">
          <ProjectAccessDialogBody
            key={`${accountId}:${projectId}`}
            projectId={projectId}
            onClose={onClose}
            onAccessGranted={onAccessGranted}
          />
        </KeyboardBoundary>
      )}
    </Modal>
  );
}

function ProjectAccessDialogBody({
  projectId,
  onClose,
  onAccessGranted,
}: {
  projectId: string;
  onClose: () => void;
  onAccessGranted?: () => Promise<void> | void;
}) {
  const [info, setInfo] = useState<ProjectAccessLandingInfo>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    void webapp_client.project_collaborators
      .get_access_landing_info({ project_id: projectId })
      .then(
        (value) => {
          if (!cancelled) setInfo(value);
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [projectId, retry]);
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        title="Could not load project access options."
        description="Check your connection and try again."
        action={<Button onClick={() => setRetry(retry + 1)}>Retry</Button>}
      />
    );
  if (!info) return <div role="status">Loading project access...</div>;
  return (
    <ProjectAccessLandingPage
      info={info}
      loading={false}
      error={null}
      onChange={setInfo}
      embedded
      onBack={onClose}
      backLabel="Done"
      onAccessGranted={async () => {
        onClose();
        await onAccessGranted?.();
      }}
    />
  );
}
