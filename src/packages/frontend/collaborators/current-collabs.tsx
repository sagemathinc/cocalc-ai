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
    if (isOwner && isFlyout) {
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
          type={isFlyout ? "link" : "default"}
          style={{
            marginBottom: "0",
            ...(isFlyout
              ? { color: COLORS.ANTD_RED_WARN, paddingInline: 0 }
              : {}),
          }}
        >
          <Icon name="user-times" /> {intl.formatMessage(labels.remove)} ...
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
          borderBottom: is_last ? undefined : `1px solid ${COLORS.GRAY_LL}`,
          display: "grid",
          gap: isFlyout ? 10 : 14,
          gridTemplateColumns: "minmax(0, 1fr) auto auto",
          padding: isFlyout ? "8px 0" : "10px 0",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <User
            account_id={user.account_id}
            user_map={user_map}
            show_avatar={true}
          />
          <div
            style={{
              color: COLORS.GRAY_M,
              fontSize: "12px",
              marginLeft: isFlyout ? 38 : 42,
              marginTop: 2,
            }}
          >
            {render_last_active(user.last_active)}
          </div>
        </div>
        {render_role(user.group)}
        <div style={{ minWidth: isFlyout ? 66 : 90, textAlign: "right" }}>
          {user_remove_button(user.account_id, user.group)}
        </div>
      </div>
    );
  }

  function render_last_active(last_active?: Date | number) {
    if (!last_active) {
      return "No recent project activity";
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
      maxHeight: isFlyout ? "240px" : "20em",
      overflowY: "auto",
      overflowX: "hidden",
      marginBottom: "0",
      display: "flex",
      flexDirection: "column",
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
          style={{ ...style, backgroundColor: "white" }}
          styles={{ body: { padding: "4px 14px" } }}
        >
          {render_users(users)}
        </Card>
      );
    }
  }

  const introText = intl.formatMessage({
    id: "collaborators.current-collabs.intro",
    defaultMessage:
      "Collaborators can edit files, run code, manage this project, and invite others.",
  });

  switch (mode) {
    case "project": {
      const users = get_users();
      return (
        <SettingBox title="Current Collaborators" icon="user">
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span>{introText}</span>
            <Tag style={{ marginInlineEnd: 0 }}>
              {users.length} {users.length === 1 ? "person" : "people"}
            </Tag>
          </div>
          <hr />
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
