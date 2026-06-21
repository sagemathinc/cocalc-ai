/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Checkbox } from "antd";
import { isEqual } from "lodash";
import { useEffect, useRef, useState } from "react";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";

import {
  redux,
  useIsMountedRef,
  useProjectMapField,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Paragraph, Tip } from "@cocalc/frontend/components";
import { useProjectCourseInfo } from "@cocalc/frontend/project/use-project-course";
import { isViewerProjectRole } from "@cocalc/frontend/project/realtime-access";
import { course, IntlMessage, labels } from "@cocalc/frontend/i18n";
import { R_IDE } from "@cocalc/util/consts/ui";
import {
  normalizeStudentProjectFunctionality,
  type StudentProjectFunctionality,
} from "@cocalc/util/db-schema/projects";

export type { StudentProjectFunctionality };

interface Option {
  name: string;
  title: IntlMessage;
  description: IntlMessage;
  notImplemented?: boolean;
}

const OPTIONS: Option[] = [
  {
    name: "disableActions",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableActions.title",
      defaultMessage: "Disable file actions",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableActions.description",
      defaultMessage:
        "Make it so students can't delete, download, copy, publish, etc., files in their project.  See the Disable Publish sharing option below if you just want to disable publishing.",
    }),
  },
  {
    name: "disableJupyterToggleReadonly",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterToggleReadonly.title",
      defaultMessage:
        "Disable toggling whether cells are editable or deletable",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterToggleReadonly.description",
      defaultMessage:
        "Make it so that in Jupyter notebooks, students can't toggle whether cells are editable or deletable, and also disables the RAW Json Editor and the Jupyter command list dialog.  If you set this, you should probably disable all of the JupyterLab and Jupyter classic options too.",
    }),
  },
  {
    name: "disableJupyterClassicServer",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterClassicServer.title",
      defaultMessage: "Disable Jupyter Classic notebook server",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterClassicServer.description",
      defaultMessage:
        "Disable the user interface for running a Jupyter classic server in student projects.  This is important, since Jupyter classic provides its own extensive download and edit functionality; moreover, you may want to disable Jupyter classic to reduce confusion if you don't plan to use it.",
    }),
  },
  {
    name: "disableJupyterLabServer",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterLabServer.title",
      defaultMessage: "Disable JupyterLab notebook server",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableJupyterLabServer.description",
      defaultMessage:
        "Disable the user interface for running a JupyterLab server in student projects.  This is important, since JupyterLab it provides its own extensive download and edit functionality; moreover, you may want to disable JupyterLab to reduce confusion if you don't plan to use it.",
    }),
  },
  {
    name: "disableVSCodeServer",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableVSCodeServer.title",
      defaultMessage: "Disable VS Code IDE Server",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableVSCodeServer.description",
      defaultMessage:
        "Disable the VS Code IDE Server, which lets you run VS Code in a project with one click.",
    }),
  },
  {
    name: "disablePlutoServer",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disablePlutoServer.title",
      defaultMessage: "Disable Pluto Julia notebook server",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disablePlutoServer.description",
      defaultMessage:
        "Disable the user interface for running a pluto server in student projects.  Pluto lets you run Julia notebooks from a project.",
    }),
  },
  {
    name: "disableRServer",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableRServer.title",
      defaultMessage: "{R_IDE}",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableRServer.description",
      defaultMessage: `Disable the user interface for running the {R_IDE} server in student projects.  This is an IDE for coding in R.`,
    }),
  },
  {
    name: "disableTerminals",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableTerminals.title",
      defaultMessage: "Disable command line terminal",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableTerminals.description",
      defaultMessage:
        "Disables opening or running command line terminals in student projects.",
    }),
  },
  {
    name: "disableUploads",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableUploads.title",
      defaultMessage: "Disable file uploads",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableUploads.description",
      defaultMessage:
        "Blocks uploading files to the student project via drag-n-drop or the Upload button.",
    }),
  },
  {
    name: "disableCollaborators",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableCollaborators.title",
      defaultMessage: "Disable adding or removing collaborators",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableCollaborators.description",
      defaultMessage:
        "Removes the user interface for adding or removing collaborators from student projects.",
    }),
  },
  //   {
  //     notImplemented: true,
  //     name: "disableAPI",
  //     title: "Disable API keys",
  //     description:
  //       "Makes it so the HTTP API is blocked from accessing the student project.  A student might use the API to get around various other restrictions.",
  //   },
  {
    name: "disableAI",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableAI.title",
      defaultMessage: "Disable all AI integration",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableAI.description",
      defaultMessage:
        "Remove *all* AI integrations from the student projects. This is a hint for honest students, since of course students can still use copy/paste to accomplish the same thing.",
    }),
  },
  {
    name: "disableSomeAI",
    title: defineMessage({
      id: "course.customize-student-project-functionality.disableSomeAI.title",
      defaultMessage: "Disable some AI integration",
    }),
    description: defineMessage({
      id: "course.customize-student-project-functionality.disableSomeAI.description",
      defaultMessage:
        "Disable AI integration except for 'Hint', 'Explain' buttons, and chat replies. Students can get hints to help them get unstuck, but cannot get complete solutions from 'Help me fix'.",
    }),
  },
] as const;

interface Props {
  functionality: StudentProjectFunctionality;
  onChange: (StudentProjectFunctionality) => Promise<void>;
}

export function CustomizeStudentProjectFunctionality({
  functionality,
  onChange,
}: Props) {
  const intl = useIntl();
  const [state, setState] = useState<StudentProjectFunctionality>(
    normalizeStudentProjectFunctionality(functionality),
  );
  const [saving, setSaving] = useState<boolean>(false);

  function onChangeState(obj: StudentProjectFunctionality) {
    const newState = { ...state };
    for (const key in obj) {
      newState[key] = obj[key];
    }
    setState(newState);
  }

  const isMountedRef = useIsMountedRef();

  const lastFunctionalityRef =
    useRef<StudentProjectFunctionality>(functionality);
  useEffect(() => {
    if (isEqual(functionality, lastFunctionalityRef.current)) {
      return;
    }
    // some sort of upstream change
    lastFunctionalityRef.current = functionality;
    setState(normalizeStudentProjectFunctionality(functionality));
  }, [functionality]);

  function renderOption(option: Option) {
    const { name } = option;
    const description = intl.formatMessage(option.description, { R_IDE });

    let title = intl.formatMessage(option.title, { R_IDE });
    if (option.notImplemented) {
      const msg = intl.formatMessage(labels.not_implemented).toUpperCase();
      title += ` (${msg})`;
    }

    return (
      <Tip key={name} title={title} tip={description}>
        <Checkbox
          disabled={saving}
          checked={state[name]}
          onChange={(e) =>
            onChangeState({
              [name]: (e.target as any).checked,
            })
          }
        >
          {title}
        </Checkbox>
        <br />
      </Tip>
    );
  }

  const options: React.JSX.Element[] = [];
  for (const option of OPTIONS) {
    options.push(renderOption(option));
  }

  const title = intl.formatMessage(course.restrict_student_projects);

  return (
    <Card
      title={
        <>
          <Icon name="lock" /> {title}
        </>
      }
    >
      <Paragraph type="secondary">
        <FormattedMessage
          id="course.customize-student-project-functionality.description"
          defaultMessage={`Check any of the boxes below
          to remove the corresponding functionality from all student projects.
          Hover over an option for more information about what it disables.
          This is useful to reduce student confusion and keep the students more focused,
          e.g., during an exam.
          <i>
            Do not gain a false sense of security and expect these to prevent all forms of cheating.
          </i>`}
        />
      </Paragraph>
      <hr />
      <div
        style={{
          border: "1px solid lightgrey",
          padding: "10px",
          borderRadius: "5px",
        }}
      >
        {options}
        <div style={{ marginTop: "8px" }}>
          <Button
            type="primary"
            disabled={saving || isEqual(functionality, state)}
            onClick={async () => {
              setSaving(true);
              await onChange(state);
              if (isMountedRef.current) {
                setSaving(false);
              }
            }}
          >
            {intl.formatMessage(labels.save_changes)}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function completeStudentProjectFunctionality(
  x: StudentProjectFunctionality,
) {
  return normalizeStudentProjectFunctionality(x);
}

// NOTE: we allow project_id to be undefined for convenience since some clients
// were written with that unlikely assumption on their knowledge of project_id.
type Hook = (project_id?: string) => StudentProjectFunctionality;
export const useStudentProjectFunctionality: Hook = (project_id?: string) => {
  const account_id = useTypedRedux("account", "account_id");
  const projectId = project_id ?? "";
  const projectRole = useProjectMapField<string>(projectId, [
    "users",
    account_id ?? "",
    "group",
  ]);
  const isViewer = isViewerProjectRole(projectRole ?? undefined);
  const { course } = useProjectCourseInfo(projectId, undefined, {
    enabled: !isViewer,
  });
  return course?.get("student_project_functionality")?.toJS() ?? {};
};

// Getting the information known right now about student project functionality.
// Similar to the above hook, but just a point in time snapshot.  Use this
// for old components that haven't been converted to react hooks yet.
export function getStudentProjectFunctionality(
  project_id?: string,
): StudentProjectFunctionality {
  return (
    redux
      .getStore("projects")
      ?.get_course_info(project_id ?? "")
      ?.get("student_project_functionality")
      ?.toJS() ?? {}
  );
}
