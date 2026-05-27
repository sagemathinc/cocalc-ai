/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
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
  Title,
} from "@cocalc/frontend/components";
import { Alert, Space, Switch, Typography } from "antd";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";
import { ICON_USERS, ROOT_STYLE } from "../servers/consts";
import { useProject } from "./common";

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
