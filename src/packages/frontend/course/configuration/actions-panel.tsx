/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Col, Row, Space, message } from "antd";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { useActions, useStore } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import HelpPopover from "@cocalc/frontend/course/common/help-popover";
import { course } from "@cocalc/frontend/i18n";
import type { ProjectMap } from "@cocalc/frontend/todo-types";
import { RESEND_INVITE_INTERVAL_DAYS } from "@cocalc/util/consts/invites";
import { CourseActions } from "../actions";
import { CourseStore } from "../store";
import { DeleteAllStudentProjects } from "./delete-all-student-projects";
import { DeleteAllStudents } from "./delete-all-students";
import EmptyTrash from "./empty-trash";
import { StudentProjectsStartStopPanel } from "./start-stop-panel";
import { TerminalCommandPanel } from "./terminal-command";

interface Props {
  name: string;
  project_map: ProjectMap;
  configuring_projects?: boolean;
  reinviting_students?: boolean;
}

export function ActionsPanel({
  name,
  project_map,
  configuring_projects,
  reinviting_students,
}: Props) {
  const actions = useActions<CourseActions>({ name });

  return (
    <div className="smc-vfill" style={{ overflowY: "scroll" }}>
      <Row>
        <Col md={12} style={{ padding: "15px 15px 15px 0" }}>
          <StartAllProjects name={name} project_map={project_map} />
          <br />
          <ReconfigureAllProjects
            configuring_projects={configuring_projects}
            actions={actions}
          />
          <br />
          <TerminalCommandPanel name={name} />
          <br />
          <ExportGrades actions={actions} />
        </Col>
        <Col md={12} style={{ padding: "15px" }}>
          <ResendInvites
            actions={actions}
            reinviting_students={reinviting_students}
          />
          <br />
          <CopyMissingHandoutsAndAssignments actions={actions} />
          <br />
          <EmptyTrash />
          <br />
          <DeleteAllStudentProjects actions={actions} />
          <br />
          <DeleteAllStudents actions={actions} />
        </Col>
      </Row>
    </div>
  );
}

export function StartAllProjects({ name, project_map }) {
  const store = useStore<CourseStore>({ name });
  const r = store.num_running_projects(project_map);
  const n = store.num_students();
  return (
    <StudentProjectsStartStopPanel
      name={name}
      num_running_projects={r}
      num_students={n}
    />
  );
}

export function ExportGrades({ actions, close }: { actions; close? }) {
  const intl = useIntl();

  async function save_grades_to_csv() {
    await actions.export.to_csv();
    close?.();
  }

  async function save_grades_to_py() {
    await actions.export.to_py();
    close?.();
  }

  async function save_grades_to_json() {
    await actions.export.to_json();
    close?.();
  }

  return (
    <Card
      title={
        <>
          <Icon name="table" /> {intl.formatMessage(course.export_grades)}
          <HelpPopover
            title={intl.formatMessage(course.export_grades)}
            content={
              <FormattedMessage
                id="course.actions-panel.export-grades.info"
                defaultMessage={`Export all the grades you have recorded for students in your course
                to a CSV or Python file.
                {br}
                In Microsoft Excel, you can <A>import the CSV file</A>.`}
                values={{
                  A: (c) => (
                    <a
                      target="_blank"
                      href="https://support.microsoft.com/en-us/office/import-or-export-text-txt-or-csv-files-5250ac4c-663c-47ce-937b-339e391393ba?ui=en-us&rs=en-us&ad=us"
                    >
                      {c}
                    </a>
                  ),
                  br: <br />,
                }}
              />
            }
          />
        </>
      }
    >
      <div style={{ marginBottom: "10px" }}>
        <FormattedMessage
          id="course.actions-panel.export-grades.title"
          defaultMessage="Save grades to..."
        />
      </div>
      <Space>
        <Button onClick={save_grades_to_csv}>
          <Icon name="csv" /> CSV file...
        </Button>
        <Button onClick={save_grades_to_json}>
          <Icon name="file-code" /> JSON file...
        </Button>
        <Button onClick={save_grades_to_py}>
          <Icon name="file-code" /> Python file...
        </Button>
      </Space>
    </Card>
  );
}

export function ReconfigureAllProjects({
  actions,
  configuring_projects,
}: {
  actions;
  configuring_projects?: boolean;
}) {
  const intl = useIntl();

  return (
    <Card
      title={
        <>
          <Icon name="envelope" />{" "}
          {intl.formatMessage(course.reconfigure_all_projects)}
          <HelpPopover
            title={intl.formatMessage(course.reconfigure_all_projects)}
            content={
              <FormattedMessage
                id="course.actions-panel.reconfigure-all-projects.info"
                defaultMessage={`Ensure all projects have the correct students and TA's,
                titles and descriptions set, etc.
                This will also resend any outstanding email invitations.`}
              />
            }
          />
        </>
      }
    >
      <Button
        disabled={configuring_projects}
        onClick={() => {
          actions.configuration.configure_all_projects();
        }}
      >
        {configuring_projects ? <Icon name="cocalc-ring" spin /> : undefined}{" "}
        {intl.formatMessage(course.reconfigure_all_projects)}
      </Button>
    </Card>
  );
}

export function ResendInvites({
  actions,
  reinviting_students,
}: {
  actions;
  reinviting_students?;
}) {
  const intl = useIntl();
  const [copyingInviteLinks, setCopyingInviteLinks] = useState<boolean>(false);

  async function copyPendingInviteLinks() {
    setCopyingInviteLinks(true);
    try {
      const links =
        await actions.student_projects.get_pending_student_invite_links();
      if (!links) {
        void message.info("No pending course invite links found.");
        return;
      }
      await navigator.clipboard.writeText(links);
      void message.success("Pending course invite links copied.");
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setCopyingInviteLinks(false);
    }
  }

  return (
    <Card
      title={
        <>
          <Icon name="envelope" /> {intl.formatMessage(course.resend_invites)}
          <HelpPopover
            title={intl.formatMessage(course.resend_invites)}
            content={
              <FormattedMessage
                id="course.actions-panel.resend-invite.info"
                defaultMessage={`Create or resend pending invite links for every student who has not signed up yet.
                When email is configured, CoCalc also emails those links. Otherwise,
                use "Copy pending invite links" and send them manually. This sends at
                most one email every {days} {days, plural, one {day} other {days}}.`}
                values={{ days: RESEND_INVITE_INTERVAL_DAYS }}
              />
            }
          />
        </>
      }
    >
      <Space
        size={[8, 8]}
        wrap
        style={{
          alignItems: "center",
          display: "flex",
          width: "100%",
        }}
      >
        <Button
          disabled={reinviting_students}
          onClick={() => {
            actions.student_projects.reinvite_oustanding_students();
          }}
        >
          {reinviting_students ? <Icon name="cocalc-ring" spin /> : undefined}{" "}
          <FormattedMessage
            id="course.actions-panel.resend-invite.button"
            defaultMessage={"Reinvite students"}
            description={"Resending email invitiatons to students in a course."}
          />
        </Button>
        <Button
          disabled={reinviting_students}
          loading={copyingInviteLinks}
          onClick={() => void copyPendingInviteLinks()}
        >
          <Icon name="copy" /> Copy pending invite links
        </Button>
      </Space>
    </Card>
  );
}

export function CopyMissingHandoutsAndAssignments({ actions }) {
  const intl = useIntl();
  return (
    <Card
      title={
        <>
          <Icon name="share-square" />{" "}
          {intl.formatMessage(course.copy_missing_handouts_assignments)}
          <HelpPopover
            title={intl.formatMessage(course.copy_missing_handouts_assignments)}
            content={
              <FormattedMessage
                id="course.actions-panel.copy-missing-handouts-assignments"
                defaultMessage={`If you <b>add new students</b> to your course,
                you can click this button to ensure they have all the assignments and handouts
                that you have already assigned to other students in the course.`}
                values={{ b: (c) => <b>{c}</b> }}
              />
            }
          />
        </>
      }
    >
      <Button
        onClick={() => {
          actions.configuration.push_missing_handouts_and_assignments();
        }}
      >
        <Icon name="share-square" />{" "}
        {intl.formatMessage(course.copy_missing_handouts_assignments)}
      </Button>
    </Card>
  );
}
