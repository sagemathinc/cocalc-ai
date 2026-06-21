/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { UsergroupAddOutlined } from "@ant-design/icons";
import { Button, Card, Popconfirm } from "antd";
import { FormattedMessage, useIntl } from "react-intl";

import { useActions, useRedux } from "@cocalc/frontend/app-framework";
import type { AppRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import { course } from "@cocalc/frontend/i18n";
import { CancelText } from "@cocalc/frontend/i18n/components";
import { CourseActions } from "../actions";
import { CourseSettingsRecord } from "../store";
import { DeleteSharedProjectPanel } from "./delete-shared-project";

interface SharedProjectPanelProps {
  settings: CourseSettingsRecord;
  redux: AppRedux;
  name: string;
  close?: Function;
  embedded?: boolean;
}

export function SharedProjectPanel({
  settings,
  redux,
  name,
  close,
  embedded,
}: SharedProjectPanelProps) {
  const intl = useIntl();

  const actions = useActions<CourseActions>({ name });
  const courseProjectId = useRedux([name, "course_project_id"]);

  const haveSharedProject = !!settings.get("shared_project_id");

  function panel_header_text(): string {
    return intl.formatMessage({
      id: "course.shared-project-panel.header",
      defaultMessage: "Shared project",
    });
  }

  function render_content() {
    if (haveSharedProject) {
      return render_has_shared_project();
    } else {
      return render_no_shared_project();
    }
  }

  function render_has_shared_project() {
    return (
      <>
        <div>
          <Button onClick={open_project} type={"primary"}>
            <FormattedMessage
              id="course.shared-project-panel.have_project.button"
              defaultMessage={"Open shared project"}
            />
          </Button>
        </div>
        <hr />
        <DeleteSharedProjectPanel
          settings={settings}
          actions={actions}
          close={close}
        />
      </>
    );
  }

  function open_project(): void {
    redux.getActions("projects").open_project({
      project_id: settings.get("shared_project_id"),
    });
    close?.();
  }

  function render_no_shared_project() {
    return (
      <div>
        <Popconfirm
          title={
            <div style={{ maxWidth: "400px" }}>
              <FormattedMessage
                id="course.shared-project-panel.create_project.confirmation"
                defaultMessage={`Are you sure you want to create a shared project
                and add all students in this course as collaborators?`}
              />
            </div>
          }
          onConfirm={() => {
            const actions = redux.getActions(name) as CourseActions;
            if (actions != null) {
              actions.shared_project.create();
              close?.();
            }
          }}
          okText={intl.formatMessage(course.create_shared_project)}
          cancelText={<CancelText />}
        >
          <Button icon={<UsergroupAddOutlined />}>
            {intl.formatMessage(course.create_shared_project)}...
          </Button>
        </Popconfirm>
      </div>
    );
  }

  const card = (
    <Card
      style={embedded ? undefined : { maxWidth: "800px", margin: "auto" }}
      title={
        <>
          <Icon name="users" /> {panel_header_text()}
          {" ("}
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() =>
              openProjectDocs({
                projectId: `${courseProjectId ?? ""}`,
                slug: "teaching/shared-project",
              })
            }
          >
            Docs
          </Button>
          {")"}
        </>
      }
    >
      {render_content()}
    </Card>
  );

  if (embedded) return card;
  return (
    <div className="smc-vfill" style={{ overflow: "auto" }}>
      {card}
    </div>
  );
}
