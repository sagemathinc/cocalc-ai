/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import ShowError from "@cocalc/frontend/components/error";
import { Button, Col, Flex, Row, Typography } from "antd";
import React, { useState } from "react";
import { useIntl } from "react-intl";

import { useProjectFromMap } from "@cocalc/frontend/app-framework";
import {
  CopyToClipBoard,
  LabeledRow,
  Paragraph,
  SettingBox,
  ThemeEditorModal,
  TimeAgo,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import {
  ProjectThemeAvatar,
  projectThemeFromProject,
} from "@cocalc/frontend/projects/theme";
import { ProjectsActions } from "@cocalc/frontend/todo-types";
import { useProjectCourseInfo } from "../use-project-course";
import { useProjectCreated } from "../use-project-created";
import {
  themeDraftFromTheme,
  themeFromDraft,
  type ThemeEditorDraft,
} from "@cocalc/frontend/theme/types";

interface Props {
  project_title: string;
  project_id: string;
  description: string;
  actions: ProjectsActions;
  mode?: "project" | "flyout";
  embedded?: boolean;
}

export const AboutBox: React.FC<Props> = (props: Readonly<Props>) => {
  const {
    project_title,
    project_id,
    description,
    actions,
    mode = "project",
    embedded = false,
  } = props;
  const isEmbedded = embedded || mode === "flyout";
  const isFlyout = mode === "flyout";
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const { course } = useProjectCourseInfo(project_id);
  const courseProjectType = course?.get("type") as any;
  const hasReadonlyFields = ["student", "shared"].includes(courseProjectType);
  const [error, setError] = useState<string>("");
  const projectRecord = useProjectFromMap(project_id);
  const theme = projectThemeFromProject(projectRecord);
  const [appearanceOpen, setAppearanceOpen] = useState<boolean>(false);
  const [appearanceSaving, setAppearanceSaving] = useState<boolean>(false);
  const [appearanceDraft, setAppearanceDraft] =
    useState<ThemeEditorDraft | null>(null);
  const { created } = useProjectCreated(project_id);

  function renderReadonly() {
    if (!hasReadonlyFields) return;
    return (
      <Row>
        <Col span={24}>
          <Typography.Text type="secondary" italic>
            Title and Description are controlled by the course managers in the
            course configuration tab.
          </Typography.Text>
        </Col>
      </Row>
    );
  }

  function openAppearanceModal() {
    setAppearanceDraft(
      themeDraftFromTheme(
        {
          title: project_title,
          description,
          ...theme,
        },
        project_title,
      ),
    );
    setAppearanceOpen(true);
  }

  async function saveAppearance() {
    if (appearanceDraft == null) return;
    try {
      setAppearanceSaving(true);
      await actions.set_project_title(project_id, appearanceDraft.title);
      await actions.set_project_description(
        project_id,
        appearanceDraft.description,
      );
      const nextTheme = themeFromDraft(appearanceDraft);
      await actions.setProjectTheme(project_id, {
        color: nextTheme.color,
        accent_color: nextTheme.accent_color,
        icon: nextTheme.icon,
        image_blob: nextTheme.image_blob,
      });
      setAppearanceOpen(false);
    } catch (err) {
      setError(`Error saving ${projectLabelLower} appearance: ${err}`);
    } finally {
      setAppearanceSaving(false);
    }
  }

  function renderBody() {
    return (
      <>
        <ShowError error={error} setError={setError} />
        {renderReadonly()}
        <LabeledRow
          label={intl.formatMessage({
            id: "project.settings.about-box.appearance.label",
            defaultMessage: "Appearance",
            description: "Appearance settings for the given project",
          })}
          vertical={isFlyout}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              width: "100%",
            }}
          >
            <div data-testid="project-appearance-image">
              <ProjectThemeAvatar
                theme={theme}
                size={36}
                shape="square"
                border
              />
            </div>
            <Button
              style={{ width: "100%" }}
              disabled={hasReadonlyFields}
              onClick={openAppearanceModal}
            >
              Edit appearance
            </Button>
          </div>
        </LabeledRow>
        {created && (
          <LabeledRow
            label={intl.formatMessage(labels.created)}
            vertical={isFlyout}
            style={{ marginBottom: "15px" }}
          >
            <TimeAgo date={created} />
          </LabeledRow>
        )}

        <LabeledRow
          key="project_id"
          label={`${projectLabel} ID`}
          vertical={isFlyout}
          style={{ marginTop: "15px" }}
        >
          {!isFlyout ? (
            <CopyToClipBoard
              inputWidth={"330px"}
              value={project_id}
              style={{ display: "inline-block", width: "100%", margin: 0 }}
            />
          ) : (
            <Paragraph
              copyable={{
                text: project_id,
                tooltips: [`Copy ${projectLabel} ID`, "Copied!"],
              }}
              code
              style={{ marginBottom: 0 }}
            >
              {project_id}
            </Paragraph>
          )}
        </LabeledRow>
        <ThemeEditorModal
          open={appearanceOpen}
          title={`Edit ${projectLabel} Appearance`}
          value={appearanceDraft}
          onChange={(patch) =>
            setAppearanceDraft((prev) =>
              prev == null ? prev : { ...prev, ...patch },
            )
          }
          onCancel={() => setAppearanceOpen(false)}
          onSave={saveAppearance}
          confirmLoading={appearanceSaving}
          error={error}
          projectId={project_id}
          defaultIcon="folder-open"
          showIcon
          showAccentColor
        />
      </>
    );
  }

  if (isEmbedded) {
    return renderBody();
  } else {
    return (
      <SettingBox
        title={
          <Flex
            justify="space-between"
            align="center"
            wrap
            gap="10px"
            style={{ width: "100%" }}
          >
            {intl.formatMessage(labels.about)}
            <ProjectTitle project_id={project_id} noClick />
          </Flex>
        }
        icon="file-alt"
      >
        {renderBody()}
      </SettingBox>
    );
  }
};
