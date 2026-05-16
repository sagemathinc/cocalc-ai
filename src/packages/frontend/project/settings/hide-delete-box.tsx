/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Switch } from "antd";
import { useState, type ReactNode } from "react";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";

import { Icon, SettingBox, type IconName } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { ProjectsActions } from "@cocalc/frontend/todo-types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { HardDeleteProjectModal } from "@cocalc/frontend/projects/hard-delete-project-modal";
import RemoveMyself from "@cocalc/frontend/projects/remove-myself";
import { ArchiveProject } from "./archive-project";
import MoveProject from "./move-project";
import { Project } from "./types";

interface Props {
  project: Project;
  actions: ProjectsActions;
  mode?: "project" | "flyout";
  embedded?: boolean;
  extraRows?: ReactNode;
  introMessage?: ReactNode;
  introDescription?: ReactNode;
}

export function HideDeleteBox(props: Readonly<Props>) {
  const {
    project,
    actions,
    mode = "project",
    embedded = false,
    extraRows,
    introMessage = "Danger Zone",
    introDescription = `These actions change project visibility or lifecycle state. They are separated from normal settings so they are harder to trigger accidentally.`,
  } = props;
  const isFlyout = mode === "flyout";
  const isEmbedded = embedded || isFlyout;
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const is_deleted = project.get("deleted");
  const project_id = project.get("project_id");
  const projectTitle = `${project.get("title") ?? ""}`.trim();
  const projectName = `${project.get("name") ?? ""}`.trim();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  function toggle_hide_project(): void {
    actions.toggle_hide_project(project_id);
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
          message={introMessage}
          description={introDescription}
        />
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
        {extraRows}
        {isOwner ? (
          <DangerActionRow
            icon="trash"
            title={`Delete ${projectLabel}`}
            description={
              is_deleted
                ? `This ${projectLabelLower} is already marked deleted. Permanent delete will remove the workspace record and data.`
                : `Permanently delete this ${projectLabelLower} for everyone. This requires fresh authentication and cannot be undone.`
            }
            action={
              <Button
                danger
                icon={<Icon name="trash" />}
                onClick={() => {
                  setDeleteModalOpen(true);
                }}
              >
                Delete...
              </Button>
            }
          />
        ) : (
          <DangerActionRow
            icon="user-times"
            title="Remove Myself as Collaborator"
            description={`Leave this ${projectLabelLower}. You will no longer have access and cannot add yourself back.`}
            action={
              <RemoveMyself
                project_ids={[project_id]}
                size={isFlyout ? "small" : undefined}
                danger
                label="Remove Myself as Collaborator"
              />
            }
          />
        )}
        <HardDeleteProjectModal
          open={deleteModalOpen}
          project_id={project_id}
          title={projectTitle}
          name={projectName}
          onCancel={() => setDeleteModalOpen(false)}
        />
      </Space>
    );
  }

  if (!webapp_client.account_id) return <span>Must be signed in.</span>;
  const user = project.getIn(["users", webapp_client.account_id]);
  if (user == undefined) {
    return <span>Does not make sense for admin.</span>;
  }
  const hidden = user.get("hide");
  const isOwner = user.get("group") === "owner";
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

export function ProjectLocationBox(props: Readonly<Props>) {
  const { project, actions, mode = "project", embedded = false } = props;
  const isFlyout = mode === "flyout";
  const isEmbedded = embedded || isFlyout;
  const project_id = project.get("project_id");
  const state = project.getIn(["state", "state"]);
  const is_deleted = project.get("deleted");
  const lifecycleBusy =
    state == null ||
    ["starting", "stopping", "archiving", "unarchiving", "archived"].includes(
      state,
    );
  const movingDisabled =
    is_deleted ||
    (state != null &&
      ["starting", "stopping", "archiving", "unarchiving"].includes(state));

  function renderBody() {
    const locationRows = (
      <>
        <DangerActionRow
          icon="servers"
          title="Move Project"
          description="Move this project to another host. The project is unavailable during the move and snapshots are removed."
          action={
            <MoveProject
              project_id={project_id}
              disabled={movingDisabled}
              label="Move Project"
              showHostName={false}
              size={isFlyout ? "small" : undefined}
            />
          }
        />
        <DangerActionRow
          icon="file-archive"
          title="Archive Project"
          description="Remove the active copy from its host. Starting later restores from backup, which is slower, and snapshots are removed."
          action={
            <ArchiveProject
              project_id={project_id}
              disabled={is_deleted || lifecycleBusy}
              size={isFlyout ? "small" : undefined}
            />
          }
        />
      </>
    );
    return (
      <HideDeleteBox
        project={project}
        actions={actions}
        mode={mode}
        embedded
        extraRows={locationRows}
        introMessage="Location changes can interrupt access"
        introDescription="These controls change where the project is listed, hosted, archived, or deleted. Moving and archiving can make the project unavailable for a while and remove snapshots."
      />
    );
  }

  if (isEmbedded) {
    return renderBody();
  }
  return (
    <SettingBox title="Location" icon="servers">
      {renderBody()}
    </SettingBox>
  );
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
