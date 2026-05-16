import { Button, Modal, Popconfirm } from "antd";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import { Icon } from "@cocalc/frontend/components";

export function confirmRemoveMyselfFromProject({
  project_id,
  account_id,
  projectLabel,
  projectLabelLower,
}: {
  project_id: string;
  account_id: string | undefined;
  projectLabel: string;
  projectLabelLower: string;
}) {
  if (account_id == null) {
    Modal.error({
      title: "Unable to remove collaborator",
      content: "You must be signed in to remove yourself from a project.",
    });
    return;
  }

  Modal.confirm({
    title: `Remove Myself from ${projectLabel}`,
    content: (
      <div>
        <p>
          Are you sure you want to remove yourself from this {projectLabelLower}
          ?
        </p>
        <p>
          <strong>
            You will no longer have access and cannot add yourself back.
          </strong>
        </p>
      </div>
    ),
    okText: "Yes, Remove Me",
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await redux
          .getActions("projects")
          .remove_collaborator(project_id, account_id);
        redux.getActions("page").close_project_tab(project_id);
      } catch (error) {
        Modal.error({
          title: "Unable to remove collaborator",
          content: `${error}`,
        });
      }
    },
  });
}

export default function RemoveMyself({
  project_ids,
  size,
  danger,
  label,
}: {
  project_ids: string[];
  size?: "small";
  danger?: boolean;
  label?: ReactNode;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = projectsLabel.toLowerCase();
  const button = (
    <Button size={size} danger={danger} icon={<Icon name="times-circle" />}>
      {label ?? (
        <FormattedMessage
          id="projects.remove-myself.button"
          defaultMessage="Remove Myself..."
        />
      )}
    </Button>
  );

  if (project_ids.length === 1) {
    return (
      <span
        onClick={() =>
          confirmRemoveMyselfFromProject({
            project_id: project_ids[0],
            account_id,
            projectLabel,
            projectLabelLower,
          })
        }
      >
        {button}
      </span>
    );
  }

  return (
    <Popconfirm
      title={intl.formatMessage(
        {
          id: "projects.remove-myself.title",
          defaultMessage: "Remove myself from {projectsLabel}",
        },
        { projectsLabel: projectsLabelLower },
      )}
      description={
        <div style={{ maxWidth: "400px" }}>
          <FormattedMessage
            id="projects.remove-myself.description"
            defaultMessage={`Are you sure to remove yourself from up to {count, plural, one {# {projectLabel}} other {# {projectsLabel}}}? You will no longer have access and cannot add yourself back. <b>You will not be removed from {projectsLabel} you own.</b>`}
            values={{
              count: project_ids.length,
              projectLabel: projectLabelLower,
              projectsLabel: projectsLabelLower,
              b: (chunks) => <b>{chunks}</b>,
            }}
          />
        </div>
      }
      onConfirm={() => {
        const projects = redux.getActions("projects");
        const page = redux.getActions("page");
        for (const project_id of project_ids) {
          try {
            projects.remove_collaborator(project_id, account_id);
            page.close_project_tab(project_id);
          } catch {}
        }
      }}
      okText={intl.formatMessage(labels.yes)}
      cancelText={intl.formatMessage(labels.no)}
    >
      {button}
    </Popconfirm>
  );
}
