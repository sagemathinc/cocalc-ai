/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Popconfirm, Space, Switch } from "antd";
import { useState, type ReactNode } from "react";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";

import {
  Icon,
  Paragraph,
  SettingBox,
  type IconName,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { ProjectsActions } from "@cocalc/frontend/todo-types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { DeletedProjectWarning } from "../warnings/deleted";
import { Project } from "./types";

interface Props {
  project: Project;
  actions: ProjectsActions;
  mode?: "project" | "flyout";
  embedded?: boolean;
}

export function HideDeleteBox(props: Readonly<Props>) {
  const { project, actions, mode = "project", embedded = false } = props;
  const isFlyout = mode === "flyout";
  const isEmbedded = embedded || isFlyout;
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const is_deleted = project.get("deleted");
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  const deleteUndeleteMsg = (
    <FormattedMessage
      id="project.settings.hide-delete-box.delete.label"
      defaultMessage={`{is_deleted, select, true {Undelete {projectLabel}} other {Delete {projectLabel}}}`}
      values={{ is_deleted, projectLabel }}
    />
  );

  async function toggle_delete_project(): Promise<void> {
    setError("");
    try {
      await runFreshAuthAction(async () => {
        await actions.toggle_delete_project(project.get("project_id"));
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  function toggle_hide_project(): void {
    actions.toggle_hide_project(project.get("project_id"));
  }

  function user_has_applied_upgrades(account_id: string, project: Project) {
    const upgrades = project.getIn(["users", account_id]);
    return upgrades ? upgrades.some((val) => val > 0) : undefined;
  }

  function delete_message(): React.JSX.Element {
    if (is_deleted) {
      return <DeletedProjectWarning />;
    } else {
      return (
        <span>
          <FormattedMessage
            id="project.settings.hide-delete-box.delete.explanation"
            defaultMessage={`Delete this {projectLabel} for everyone. You can undo this for a few days after which it becomes permanent and all data in this {projectLabel} is lost.`}
            values={{ projectLabel: projectLabelLower }}
          />
        </span>
      );
    }
  }

  function hide_message(): React.JSX.Element {
    if (!webapp_client.account_id) return <span>Must be signed in.</span>;
    const user = project.getIn(["users", webapp_client.account_id]);
    if (user == undefined) {
      return <span>Does not make sense for admin.</span>;
    }

    const msg = (
      <FormattedMessage
        id="project.settings.hide-delete-box.hide.explanation"
        defaultMessage={`
          {hide, select, true {
            Unhide this {projectLabel}, so it shows up in your default {projectLabel} listing.
            Right now it only appears when hidden is checked.
          }
          other {
            Hide this {projectLabel}, so it does not show up in your default {projectLabel} listing.
            This only impacts you, not your collaborators, and you can easily unhide it.
          }}`}
        values={{ hide: hidden, projectLabel: projectLabelLower }}
      />
    );

    return <span>{msg}</span>;
  }

  function render_delete_undelete_button(): React.JSX.Element {
    if (is_deleted) {
      return (
        <Button
          danger
          onClick={toggle_delete_project}
          icon={<Icon name="trash" />}
        >
          {deleteUndeleteMsg}
        </Button>
      );
    } else {
      return (
        <Popconfirm
          placement={"bottom"}
          arrow={{ pointAtCenter: true }}
          title={render_expanded_delete_info()}
          onConfirm={toggle_delete_project}
          okText={intl.formatMessage(
            {
              id: "project.settings.hide-delete-box.delete.confirm.yes",
              defaultMessage: `Yes, please delete this {projectLabel}!`,
            },
            { projectLabel: projectLabelLower },
          )}
          cancelText={intl.formatMessage(labels.cancel)}
          styles={{ root: { maxWidth: "400px" } }}
          icon={<Icon name="trash" />}
        >
          <Button danger icon={<Icon name="trash" />}>
            {deleteUndeleteMsg}...
          </Button>
        </Popconfirm>
      );
    }
  }

  function render_expanded_delete_info(): React.JSX.Element {
    const has_upgrades =
      webapp_client.account_id == null
        ? false
        : user_has_applied_upgrades(webapp_client.account_id, project);
    return (
      <Paragraph>
        <div style={{ marginBottom: "5px" }}>
          {intl.formatMessage(
            {
              id: "project.settings.hide-delete-box.delete.warning.title",
              defaultMessage: `Are you sure you want to delete this {projectLabel}?`,
            },
            { projectLabel: projectLabelLower },
          )}
        </div>
        {has_upgrades ? (
          <Alert
            showIcon
            style={{ margin: "15px" }}
            type="info"
            description={intl.formatMessage(
              {
                id: "project.settings.hide-delete-box.delete.warning.info",
                defaultMessage: `All of your upgrades from this {projectLabel} will be removed automatically.
              Undeleting the {projectLabel} will not automatically restore them.
              This will not affect upgrades other people have applied.`,
              },
              { projectLabel: projectLabelLower },
            )}
          />
        ) : undefined}
      </Paragraph>
    );
  }

  function renderBody() {
    const hide_label = intl.formatMessage(
      {
        id: "project.settings.hide-delete-box.hide.label",
        defaultMessage: `{hidden, select, true {Unhide {projectLabel}} other {Hide {projectLabel}}}`,
      },
      { hidden, projectLabel },
    );

    const hide_switch = defineMessage({
      id: "project.settings.hide-delete-box.hide.switch",
      defaultMessage: `{hidden, select, true {Hidden} other {Visible}}`,
      description: "The project is either visible or hidden",
    });

    return (
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="warning"
          showIcon
          message="Danger Zone"
          description={`These actions change project visibility or lifecycle state. They are separated from normal settings so they are harder to trigger accidentally.`}
        />
        {error ? (
          <Alert
            type="error"
            showIcon
            message="Unable to change project deletion state"
            description={error}
            closable
            onClose={() => setError("")}
          />
        ) : undefined}
        <DangerActionRow
          icon={hidden ? "eye-slash" : "eye"}
          title={hide_label}
          description={hide_message()}
          action={
            <Switch
              checked={hidden}
              checkedChildren={intl.formatMessage(hide_switch, {
                hidden: true,
              })}
              unCheckedChildren={intl.formatMessage(hide_switch, {
                hidden: false,
              })}
              onChange={toggle_hide_project}
            />
          }
        />
        <DangerActionRow
          icon="trash"
          title={deleteUndeleteMsg}
          description={
            <Space direction="vertical" size={4}>
              <span>{delete_message()}</span>
            </Space>
          }
          action={render_delete_undelete_button()}
        />
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    );
  }

  if (!webapp_client.account_id) return <span>Must be signed in.</span>;
  const user = project.getIn(["users", webapp_client.account_id]);
  if (user == undefined) {
    return <span>Does not make sense for admin.</span>;
  }
  const hidden = user.get("hide");
  if (isEmbedded) {
    return renderBody();
  } else {
    return (
      <SettingBox
        title={intl.formatMessage(
          {
            id: "project.settings.hide-delete-box.title",
            defaultMessage: "Hide or Delete {projectLabel}",
          },
          { projectLabel },
        )}
        icon="warning"
      >
        {renderBody()}
      </SettingBox>
    );
  }
}

function DangerActionRow({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 12,
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: COLORS.GRAY_M,
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          <Icon name={icon} /> {title}
        </div>
        <div style={{ color: COLORS.GRAY_M }}>{description}</div>
      </div>
      <div>{action}</div>
    </div>
  );
}
