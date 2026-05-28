/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Modal, Popconfirm, Tag } from "antd";
import React from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { CSS, redux, useRedux } from "@cocalc/frontend/app-framework";
import { Icon, SettingBox, TimeAgo } from "@cocalc/frontend/components";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { labels } from "@cocalc/frontend/i18n";
import { CancelText } from "@cocalc/frontend/i18n/components";
import { Project } from "@cocalc/frontend/project/settings/types";
import { COLORS } from "@cocalc/util/theme";
import { FIX_BORDER } from "../project/page/common";
import { User } from "../users";
import { Avatar } from "../account/avatar/avatar";
import {
  ViewerReadPolicyEditor,
  viewerReadPolicySummary,
} from "./viewer-read-policy";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";

interface Props {
  project: Project;
  user_map?: any;
  mode?: "project" | "flyout";
}

export const CurrentCollaboratorsPanel: React.FC<Props> = (props: Props) => {
  const { project, user_map, mode = "project" } = props;
  const isFlyout = mode === "flyout";
  const intl = useIntl();
  const current_account_id = useRedux("account", "account_id");
  const isAdmin = !!useRedux("account", "is_admin");
  const sort_by_activity = useRedux("projects", "sort_by_activity");
  const student = useStudentProjectFunctionality(project.get("project_id"));
  const ownerOnly = project.get("manage_users_owner_only") === true;
  const currentGroup = project.getIn(["users", current_account_id, "group"]);
  const currentCanManageCollaborators =
    isAdmin ||
    currentGroup === "owner" ||
    (currentGroup === "collaborator" && !ownerOnly);
  const [roleSavingAccountId, setRoleSavingAccountId] = React.useState<
    string | null
  >(null);
  const [viewerRoleDialog, setViewerRoleDialog] = React.useState<{
    account_id: string;
    read_policy: ProjectViewerReadPolicy;
  } | null>(null);

  function remove_collaborator(account_id: string) {
    const project_id = project.get("project_id");
    redux.getActions("projects").remove_collaborator(project_id, account_id);
    if (account_id === current_account_id) {
      (redux.getActions("page") as any).close_project_tab(project_id);
      // TODO: better types
    }
  }

  function user_remove_confirm_text(account_id: string) {
    const style: CSS = { maxWidth: "300px" };
    if (account_id === current_account_id) {
      return (
        <div style={style}>
          <FormattedMessage
            id="collaborators.current-collabs.remove_self"
            defaultMessage={`Are you sure you want to remove <b>yourself</b> from this project?
              You will no longer have access to this project and cannot add yourself back.`}
          />
        </div>
      );
    } else {
      return (
        <div style={style}>
          <FormattedMessage
            id="collaborators.current-collabs.remove_other"
            defaultMessage={`Are you sure you want to remove {user} from this project?
              They will no longer have access to this project.`}
            values={{
              user: <User account_id={account_id} user_map={user_map} />,
            }}
          />
        </div>
      );
    }
  }

  function user_remove_button(account_id: string, group?: string) {
    const isSelf = account_id === current_account_id;
    if (student.disableCollaborators && !isSelf) return;
    const text = user_remove_confirm_text(account_id);
    const isOwner = group === "owner";
    if (isOwner) {
      return null;
    }
    if (!isSelf && !currentCanManageCollaborators) {
      return null;
    }
    return (
      <Popconfirm
        title={text}
        onConfirm={() => remove_collaborator(account_id)}
        okText={"Yes, remove collaborator"}
        cancelText={<CancelText />}
        disabled={isOwner}
      >
        <Button
          disabled={isOwner}
          size="small"
          type="text"
          danger
          style={{
            marginBottom: "0",
            paddingInline: isFlyout ? 0 : 8,
          }}
        >
          <Icon name="user-times" /> {intl.formatMessage(labels.remove)}
        </Button>
      </Popconfirm>
    );
  }

  async function set_user_role(
    account_id: string,
    role: "collaborator" | "viewer",
    read_policy?: ProjectViewerReadPolicy | null,
  ) {
    setRoleSavingAccountId(account_id);
    try {
      await redux
        .getActions("projects")
        .set_project_user_role(
          project.get("project_id"),
          account_id,
          role,
          read_policy,
        );
    } finally {
      setRoleSavingAccountId(null);
    }
  }

  function user_role_button(
    account_id: string,
    group?: string,
    read_policy?: ProjectViewerReadPolicy | null,
  ) {
    if (!currentCanManageCollaborators || group === "owner") {
      return null;
    }
    if (account_id === current_account_id && !isAdmin) {
      return null;
    }
    const nextRole = group === "viewer" ? "collaborator" : "viewer";
    const label = nextRole === "viewer" ? "Make viewer" : "Make collaborator";
    if (nextRole === "viewer") {
      return (
        <Button
          loading={roleSavingAccountId === account_id}
          size="small"
          type="text"
          style={{
            marginBottom: "0",
            paddingInline: isFlyout ? 0 : 8,
          }}
          onClick={() =>
            setViewerRoleDialog({
              account_id,
              read_policy:
                read_policy ?? DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
            })
          }
        >
          {label}
        </Button>
      );
    }
    const title =
      "Change this viewer back to a full collaborator? They will regain normal project write and runtime access.";
    return (
      <Popconfirm
        title={<div style={{ maxWidth: 360 }}>{title}</div>}
        onConfirm={() => void set_user_role(account_id, nextRole)}
        okText={label}
        cancelText={<CancelText />}
      >
        <Button
          loading={roleSavingAccountId === account_id}
          size="small"
          type="text"
          style={{
            marginBottom: "0",
            paddingInline: isFlyout ? 0 : 8,
          }}
        >
          {label}
        </Button>
      </Popconfirm>
    );
  }

  function render_viewer_role_modal(): React.JSX.Element | undefined {
    if (viewerRoleDialog == null) {
      return;
    }
    return (
      <Modal
        title="Make this user a viewer"
        open
        okText="Make viewer"
        cancelText={<CancelText />}
        confirmLoading={roleSavingAccountId === viewerRoleDialog.account_id}
        onCancel={() => setViewerRoleDialog(null)}
        onOk={() => {
          const { account_id, read_policy } = viewerRoleDialog;
          void set_user_role(account_id, "viewer", read_policy).then(() =>
            setViewerRoleDialog(null),
          );
        }}
      >
        <p>
          Viewers can read allowed files, but cannot edit files, run code, use
          terminals, use SSH, or manage this project.
        </p>
        <ViewerReadPolicyEditor
          value={viewerRoleDialog.read_policy}
          onChange={(read_policy) =>
            setViewerRoleDialog({ ...viewerRoleDialog, read_policy })
          }
        />
      </Modal>
    );
  }

  function render_user(user: any, is_last?: boolean) {
    return (
      <div
        key={user.account_id}
        style={{
          alignItems: "center",
          background: "white",
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 10,
          boxShadow: isFlyout ? undefined : "0 1px 2px rgba(14, 43, 89, 0.04)",
          display: "grid",
          gap: isFlyout ? 10 : 14,
          gridTemplateColumns: "minmax(0, 1fr) auto",
          marginBottom: is_last ? 0 : 8,
          padding: isFlyout ? "8px 10px" : "11px 12px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            minWidth: 0,
          }}
        >
          <Avatar
            account_id={user.account_id}
            no_tooltip={true}
            no_loading
            size={isFlyout ? 30 : 34}
            style={{ flex: "0 0 auto" }}
          />
          <div style={{ marginLeft: 10, minWidth: 0 }}>
            <User
              account_id={user.account_id}
              user_map={user_map}
              show_avatar={false}
            />
            <div
              style={{
                color: COLORS.GRAY_M,
                fontSize: "12px",
                marginTop: 2,
              }}
            >
              {render_last_active(user.account_id, user.last_active)}
            </div>
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            minWidth: isFlyout ? 138 : 178,
            whiteSpace: "nowrap",
          }}
        >
          {render_role(user.group, user.read_policy)}
          {user_role_button(user.account_id, user.group, user.read_policy)}
          {user_remove_button(user.account_id, user.group)}
        </div>
      </div>
    );
  }

  function render_last_active(account_id: string, last_active?: Date | number) {
    if (!last_active) {
      const accountLastActive = user_map?.getIn?.([account_id, "last_active"]);
      if (accountLastActive) {
        return (
          <>
            Account active <TimeAgo date={accountLastActive} />
          </>
        );
      }
      return "No project activity yet";
    }
    return (
      <>
        Last active <TimeAgo date={last_active} />
      </>
    );
  }

  function render_role(
    group?: string,
    read_policy?: ProjectViewerReadPolicy | null,
  ) {
    const isOwner = group === "owner";
    const isViewer = group === "viewer";
    return (
      <span>
        <Tag
          color={isOwner ? "blue" : isViewer ? "gold" : undefined}
          style={{ marginInlineEnd: 0, textTransform: "lowercase" }}
        >
          {isOwner && <Icon name="lock" />} {group ?? "collaborator"}
        </Tag>
        {isViewer && (
          <div
            style={{
              color: COLORS.GRAY_M,
              fontSize: 11,
              marginTop: 3,
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={viewerReadPolicySummary(read_policy)}
          >
            {viewerReadPolicySummary(read_policy)}
          </div>
        )}
      </span>
    );
  }

  function get_users() {
    const u = project.get("users");
    if (u === undefined) {
      return [];
    }
    const users = u
      .map((v, k) => {
        const read_policy = v.get("read_policy") as any;
        return {
          account_id: k,
          group: v.get("group"),
          read_policy: read_policy?.toJS?.() ?? read_policy,
        };
      })
      .toList()
      .toJS();
    return sort_by_activity(users, project.get("project_id"));
  }

  function render_users(users = get_users()) {
    return users.map((u, i) => render_user(u, i === users.length - 1));
  }

  function render_collaborators_list(users = get_users()) {
    const style: CSS = {
      maxHeight: isFlyout ? "240px" : "24em",
      overflowY: "auto",
      overflowX: "hidden",
      marginBottom: "0",
      display: "flex",
      flexDirection: "column",
      paddingRight: 3,
    };
    if (isFlyout) {
      return (
        <div style={{ ...style, borderBottom: FIX_BORDER }}>
          {render_users(users)}
        </div>
      );
    } else {
      return (
        <Card
          style={{
            ...style,
            backgroundColor: COLORS.GRAY_LLL,
            borderColor: COLORS.GRAY_LL,
          }}
          styles={{ body: { padding: 10 } }}
        >
          {render_users(users)}
        </Card>
      );
    }
  }

  function render_access_summary(users: any[]) {
    const viewerCount = users.filter((user) => user.group === "viewer").length;
    const fullAccessCount = users.length - viewerCount;
    return (
      <div
        style={{
          alignItems: "center",
          background: COLORS.ANTD_BG_BLUE_L,
          border: `1px solid ${COLORS.BLUE_LLL}`,
          borderRadius: 10,
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
          marginBottom: 12,
          padding: "10px 12px",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <Icon
            name="user"
            style={{ color: COLORS.ANTD_LINK_BLUE, fontSize: 18 }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>Full project access</div>
            <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
              Collaborators can edit files and use runtimes. Viewers can only
              read allowed files.
            </div>
          </div>
        </div>
        <div>
          <Tag color="blue" style={{ marginInlineEnd: 6 }}>
            {fullAccessCount} full access
          </Tag>
          <Tag color="gold" style={{ marginInlineEnd: 0 }}>
            {viewerCount} {viewerCount === 1 ? "viewer" : "viewers"}
          </Tag>
        </div>
      </div>
    );
  }

  switch (mode) {
    case "project": {
      const users = get_users();
      return (
        <SettingBox title="Current Collaborators" icon="user">
          {render_viewer_role_modal()}
          {render_access_summary(users)}
          {render_collaborators_list(users)}
        </SettingBox>
      );
    }
    case "flyout": {
      const users = get_users();
      return (
        <div style={{ paddingLeft: "5px", paddingRight: "5px" }}>
          {render_viewer_role_modal()}
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <strong>Collaborators</strong>
            <Tag style={{ marginInlineEnd: 0 }}>
              {users.length} {users.length === 1 ? "person" : "people"}
            </Tag>
          </div>
          {render_collaborators_list(users)}
        </div>
      );
    }
  }
};
