/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import AdminWarning from "@cocalc/frontend/project/page/admin-warning";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  AddCollaborators,
  CurrentCollaboratorsPanel,
  InviteInboxPanel,
} from "@cocalc/frontend/collaborators";
import {
  Icon,
  Loading,
  Paragraph,
  SettingBox,
  TimeAgo,
  Title,
} from "@cocalc/frontend/components";
import {
  Alert,
  Button,
  Card,
  List,
  Modal,
  Space,
  Switch,
  Typography,
} from "antd";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";
import { ICON_USERS, ROOT_STYLE } from "../servers/consts";
import { useProject } from "./common";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ProjectAccessRequestBlockRow,
  ProjectAccessRequestRow,
} from "@cocalc/conat/hub/api/projects";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";

const { Text } = Typography;

interface ProjectCollaboratorsContentProps {
  project_id: string;
  layout?: "page" | "flyout";
  wrap?: (content: React.JSX.Element) => React.JSX.Element;
}

export function ProjectCollaboratorsContent({
  project_id,
  layout = "page",
  wrap,
}: ProjectCollaboratorsContentProps): React.JSX.Element {
  const intl = useIntl();
  const user_map = useTypedRedux("users", "user_map");
  const accountCustomize = useTypedRedux("account", "customize")?.toJS() as
    | { disableCollaborators?: boolean }
    | undefined;
  const student = useStudentProjectFunctionality(project_id);
  const { project, group } = useProject(project_id);
  const isOwner = group === "owner";
  const canManageAsOwnerOrAdmin = isOwner || group === "admin";
  const disableCollaborators =
    accountCustomize?.disableCollaborators || student.disableCollaborators;
  const isFlyout = layout === "flyout";
  const componentMode = isFlyout ? "flyout" : "project";

  const contentStyle = isFlyout ? { padding: "0 12px 12px 12px" } : ROOT_STYLE;

  let content: React.JSX.Element;
  if (project == null) {
    content = <Loading theme="medium" transparent={isFlyout} />;
  } else if (disableCollaborators) {
    content = (
      <Alert
        type="warning"
        showIcon
        title="Collaborator configuration is disabled."
      />
    );
  } else {
    const ownerOnly = project.get("manage_users_owner_only") === true;
    const canManageCollaborators =
      canManageAsOwnerOrAdmin || (group === "collaborator" && !ownerOnly);
    const inviteControls = (
      <AddCollaborators
        project_id={project.get("project_id")}
        where="project-settings"
        mode={componentMode}
      />
    );
    content = isFlyout ? (
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <CurrentCollaboratorsPanel
          key="current-collabs"
          project={project}
          user_map={user_map}
          mode={componentMode}
        />
        <CollaboratorManagementPolicy
          canManageCollaborators={canManageCollaborators}
          canToggle={canManageAsOwnerOrAdmin}
          ownerOnly={ownerOnly}
          project_id={project.get("project_id")}
        />
        {canManageCollaborators && inviteControls}
        {canManageCollaborators && (
          <AccessRequestsPanel project_id={project.get("project_id")} />
        )}
        {canManageCollaborators && (
          <InviteInboxPanel
            project_id={project.get("project_id")}
            mode="project"
            showWhenEmpty={true}
          />
        )}
      </Space>
    ) : (
      <div>
        <CurrentCollaboratorsPanel
          key="current-collabs"
          project={project}
          user_map={user_map}
        />
        <CollaboratorManagementPolicy
          canManageCollaborators={canManageCollaborators}
          canToggle={canManageAsOwnerOrAdmin}
          ownerOnly={ownerOnly}
          project_id={project.get("project_id")}
        />
        {canManageCollaborators && (
          <SettingBox title="Invite Collaborators" icon="UserAddOutlined">
            {inviteControls}
          </SettingBox>
        )}
        {canManageCollaborators && (
          <AccessRequestsPanel project_id={project.get("project_id")} />
        )}
        {canManageCollaborators && (
          <InviteInboxPanel
            project_id={project.get("project_id")}
            mode="project"
            showWhenEmpty={true}
          />
        )}
      </div>
    );
  }

  const body = (
    <div style={contentStyle}>
      {isFlyout ? null : (
        <Title level={2}>
          <Icon name={ICON_USERS} /> {intl.formatMessage(labels.users)}
        </Title>
      )}
      {isFlyout ? null : (
        <Paragraph>{intl.formatMessage(labels.collabs_info)}</Paragraph>
      )}
      {group !== "admin" ? null : <AdminWarning />}
      {content}
    </div>
  );

  return wrap == null ? body : wrap(body);
}

function CollaboratorManagementPolicy({
  canManageCollaborators,
  canToggle,
  ownerOnly,
  project_id,
}: {
  canManageCollaborators: boolean;
  canToggle: boolean;
  ownerOnly: boolean;
  project_id: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const allowOtherUsers = !ownerOnly;

  async function setAllowOtherUsers(value: boolean) {
    setError("");
    setSaving(true);
    try {
      await redux
        .getActions("projects")
        .set_project_manage_users_owner_only(project_id, !value);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  if (canToggle) {
    return (
      <SettingBox title="Collaborator Management" icon="users">
        <div
          style={{
            alignItems: "center",
            background: COLORS.GRAY_LLL,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 8,
            display: "grid",
            gap: 12,
            gridTemplateColumns: "minmax(0, 1fr) auto",
            padding: "10px 12px",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Text strong>Allow other users to manage collaborators</Text>
            <div style={{ color: COLORS.GRAY_M, fontSize: 12, marginTop: 2 }}>
              {allowOtherUsers
                ? "Collaborators can invite people and remove non-owner collaborators."
                : "Only project owners can invite people or remove other collaborators. Collaborators can still remove themselves."}
            </div>
          </div>
          <Switch
            checked={allowOtherUsers}
            checkedChildren="Allowed"
            disabled={saving}
            loading={saving}
            onChange={setAllowOtherUsers}
            unCheckedChildren="Owner only"
          />
        </div>
        {error && (
          <Alert
            type="error"
            showIcon
            message="Unable to update collaborator management"
            description={error}
            style={{ marginTop: 10 }}
          />
        )}
      </SettingBox>
    );
  }

  if (!canManageCollaborators) {
    return (
      <Alert
        type="info"
        showIcon
        message={
          ownerOnly
            ? "Only the project owner can manage collaborators on this project."
            : "Only project owners and collaborators can manage collaborators on this project."
        }
        description="You can still remove yourself from the current collaborators list."
      />
    );
  }

  return null;
}

function AccessRequestsPanel({
  project_id,
}: {
  project_id: string;
}): React.JSX.Element | null {
  const [requests, setRequests] = useState<ProjectAccessRequestRow[]>([]);
  const [blocks, setBlocks] = useState<ProjectAccessRequestBlockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rows, blockRows] = await Promise.all([
        webapp_client.project_collaborators.list_access_requests({
          project_id,
          status: "pending",
        }),
        webapp_client.project_collaborators.list_access_request_blocks({
          project_id,
        }),
      ]);
      setRequests(rows);
      setBlocks(blockRows);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [project_id]);

  async function respond(
    request: ProjectAccessRequestRow,
    action: "approve" | "deny" | "block",
    role?: "viewer" | "collaborator",
  ) {
    setActing(`${request.request_id}:${action}`);
    setError(null);
    try {
      await webapp_client.project_collaborators.respond_access_request({
        project_id,
        request_id: request.request_id,
        action,
        role,
      });
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setActing(null);
    }
  }

  async function unblock(blocked_account_id: string) {
    const key = `unblock:${blocked_account_id}`;
    setActing(key);
    setError(null);
    try {
      await webapp_client.project_collaborators.unblock_access_requester({
        project_id,
        blocked_account_id,
      });
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setActing(null);
    }
  }

  if (!loading && requests.length === 0 && blocks.length === 0 && !error) {
    return null;
  }

  return (
    <SettingBox title="Access Requests" icon="user-plus">
      <Space direction="vertical" style={{ width: "100%" }}>
        {error && (
          <Alert
            type="error"
            showIcon
            message="Unable to load project access requests"
            description={error}
          />
        )}
        <List
          loading={loading}
          dataSource={requests}
          locale={{ emptyText: "No pending access requests" }}
          renderItem={(request) => {
            const name =
              request.requester_name ||
              `${request.requester_first_name ?? ""} ${
                request.requester_last_name ?? ""
              }`.trim() ||
              request.requester_account_id;
            const approveKey = `${request.request_id}:approve`;
            const denyKey = `${request.request_id}:deny`;
            const blockKey = `${request.request_id}:block`;
            return (
              <List.Item
                actions={[
                  <Button
                    key="approve"
                    type="primary"
                    size="small"
                    loading={acting === approveKey}
                    onClick={() =>
                      void respond(request, "approve", request.requested_role)
                    }
                  >
                    Approve {request.requested_role}
                  </Button>,
                  request.requested_role === "collaborator" ? (
                    <Button
                      key="approve-viewer"
                      size="small"
                      onClick={() => void respond(request, "approve", "viewer")}
                    >
                      Approve viewer
                    </Button>
                  ) : null,
                  <Button
                    key="deny"
                    size="small"
                    loading={acting === denyKey}
                    onClick={() => void respond(request, "deny")}
                  >
                    Deny
                  </Button>,
                  <Button
                    key="block"
                    size="small"
                    danger
                    loading={acting === blockKey}
                    onClick={() => {
                      Modal.confirm({
                        title: "Block access requests from this user?",
                        content:
                          "This denies the current request and prevents this account from requesting access to this project again.",
                        okText: "Block",
                        okButtonProps: { danger: true },
                        onOk: () => respond(request, "block"),
                      });
                    }}
                  >
                    Block
                  </Button>,
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  avatar={
                    <Avatar
                      account_id={request.requester_account_id}
                      first_name={request.requester_first_name ?? undefined}
                      last_name={request.requester_last_name ?? undefined}
                      size={32}
                    />
                  }
                  title={name}
                  description={
                    <Space direction="vertical" size={2}>
                      <span>Requested {request.requested_role} access</span>
                      {request.message ? <span>{request.message}</span> : null}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
        {blocks.length > 0 && (
          <div>
            <Text strong>Blocked requesters</Text>
            <div
              style={{
                color: COLORS.GRAY_M,
                fontSize: 12,
                marginBottom: 8,
                marginTop: 2,
              }}
            >
              These accounts cannot send new access requests for this project.
            </div>
            {blocks.map((block) => {
              const name =
                block.blocked_name ||
                `${block.blocked_first_name ?? ""} ${
                  block.blocked_last_name ?? ""
                }`.trim() ||
                block.blocked_account_id;
              return (
                <Card
                  key={block.blocked_account_id}
                  size="small"
                  style={{ marginBottom: 8 }}
                  styles={{ body: { padding: 10 } }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      gap: 10,
                      justifyContent: "space-between",
                    }}
                  >
                    <Space>
                      <Avatar
                        account_id={block.blocked_account_id}
                        first_name={block.blocked_first_name ?? undefined}
                        last_name={block.blocked_last_name ?? undefined}
                        size={32}
                      />
                      <div>
                        <div>
                          <strong>{name}</strong>
                        </div>
                        <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
                          Blocked <TimeAgo date={block.created} />
                        </div>
                      </div>
                    </Space>
                    <Button
                      size="small"
                      loading={acting === `unblock:${block.blocked_account_id}`}
                      onClick={() => void unblock(block.blocked_account_id)}
                    >
                      Unblock
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Space>
    </SettingBox>
  );
}
