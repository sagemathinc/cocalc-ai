/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Popconfirm, Tag } from "antd";
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
  const sort_by_activity = useRedux("projects", "sort_by_activity");
  const student = useStudentProjectFunctionality(project.get("project_id"));

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
    if (student.disableCollaborators) return;
    const text = user_remove_confirm_text(account_id);
    const isOwner = group === "owner";
    if (isOwner) {
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
          {render_role(user.group)}
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

  function render_role(group?: string) {
    const isOwner = group === "owner";
    return (
      <Tag
        color={isOwner ? "blue" : undefined}
        style={{ marginInlineEnd: 0, textTransform: "lowercase" }}
      >
        {isOwner && <Icon name="lock" />} {group ?? "collaborator"}
      </Tag>
    );
  }

  function get_users() {
    const u = project.get("users");
    if (u === undefined) {
      return [];
    }
    const users = u
      .map((v, k) => ({ account_id: k, group: v.get("group") }))
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
              Edit files, run code, manage settings, and invite people.
            </div>
          </div>
        </div>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          {users.length} {users.length === 1 ? "person" : "people"}
        </Tag>
      </div>
    );
  }

  switch (mode) {
    case "project": {
      const users = get_users();
      return (
        <SettingBox title="Current Collaborators" icon="user">
          {render_access_summary(users)}
          {render_collaborators_list(users)}
        </SettingBox>
      );
    }
    case "flyout": {
      const users = get_users();
      return (
        <div style={{ paddingLeft: "5px", paddingRight: "5px" }}>
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
