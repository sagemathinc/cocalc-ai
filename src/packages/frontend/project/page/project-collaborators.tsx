/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useIntl } from "react-intl";
import AdminWarning from "@cocalc/frontend/project/page/admin-warning";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
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
import { Alert, Space } from "antd";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { labels } from "@cocalc/frontend/i18n";
import { ICON_USERS, ROOT_STYLE } from "../servers/consts";
import { useProject } from "./common";

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
        {inviteControls}
        <InviteInboxPanel
          project_id={project.get("project_id")}
          mode="project"
          showWhenEmpty={false}
        />
      </Space>
    ) : (
      <div>
        <SettingBox title="Invite Collaborators" icon="UserAddOutlined">
          {inviteControls}
        </SettingBox>
        <InviteInboxPanel
          project_id={project.get("project_id")}
          mode="project"
          showWhenEmpty={false}
        />
        <CurrentCollaboratorsPanel
          key="current-collabs"
          project={project}
          user_map={user_map}
        />
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
