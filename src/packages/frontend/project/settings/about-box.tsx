/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import ShowError from "@cocalc/frontend/components/error";
import { Alert, Button, Col, Flex, Row, Typography } from "antd";
import React, { useState } from "react";
import { useIntl } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  CopyToClipBoard,
  HelpIcon,
  Icon,
  LabeledRow,
  Paragraph,
  SettingBox,
  TextInput,
  ThemeEditorModal,
  TimeAgo,
} from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import { labels } from "@cocalc/frontend/i18n";
import { projectImageUrl } from "@cocalc/frontend/projects/image";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { ProjectsActions } from "@cocalc/frontend/todo-types";
import { useBookmarkedProjects } from "@cocalc/frontend/projects/use-bookmarked-projects";
import { useProjectCourseInfo } from "../use-project-course";
import { useProjectCreated } from "../use-project-created";
import {
  themeDraftFromTheme,
  type ThemeEditorDraft,
} from "@cocalc/frontend/theme/types";

interface Props {
  project_title: string;
  project_id: string;
  name?: string;
  description: string;
  actions: ProjectsActions;
  mode?: "project" | "flyout";
}

export const AboutBox: React.FC<Props> = (props: Readonly<Props>) => {
  const {
    name,
    project_title,
    project_id,
    description,
    actions,
    mode = "project",
  } = props;
  const isFlyout = mode === "flyout";
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = intl.formatMessage(labels.projects).toLowerCase();
  const [showNameInfo, setShowNameInfo] = useState<boolean>(false);
  const { course } = useProjectCourseInfo(project_id);
  const project_map = useTypedRedux("projects", "project_map");
  const courseProjectType = course?.get("type") as any;
  const hasReadonlyFields = ["student", "shared"].includes(courseProjectType);
  const [error, setError] = useState<string>("");
  const avatarImageBlob = project_map?.getIn([
    project_id,
    "avatar_image_tiny",
  ]) as string | undefined;
  const avatarImage = projectImageUrl(avatarImageBlob);
  const [color, setColor] = useState<string | undefined>(
    project_map?.getIn([project_id, "color"]) as string | undefined,
  );
  const [appearanceOpen, setAppearanceOpen] = useState<boolean>(false);
  const [appearanceSaving, setAppearanceSaving] = useState<boolean>(false);
  const [appearanceDraft, setAppearanceDraft] =
    useState<ThemeEditorDraft | null>(null);
  const { created } = useProjectCreated(project_id);

  const { isProjectBookmarked, setProjectBookmarked } = useBookmarkedProjects();

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
          color,
          image_blob: avatarImageBlob ?? null,
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
      const nextColor = appearanceDraft.color ?? "";
      await actions.setProjectColor(project_id, nextColor);
      await actions.setProjectImage(project_id, appearanceDraft.image_blob);
      setColor(appearanceDraft.color ?? undefined);
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
            {avatarImage ? (
              <img
                data-testid="project-appearance-image"
                src={avatarImage}
                alt={`${projectLabel} appearance`}
                style={{
                  width: 36,
                  height: 36,
                  objectFit: "cover",
                  borderRadius: 8,
                  flex: "0 0 auto",
                }}
              />
            ) : (
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: color ?? COLORS.GRAY_L,
                  flex: "0 0 auto",
                }}
              />
            )}
            <Button
              style={{ width: "100%" }}
              disabled={hasReadonlyFields}
              onClick={openAppearanceModal}
            >
              Edit appearance
            </Button>
          </div>
        </LabeledRow>
        <LabeledRow
          label={intl.formatMessage({
            id: "project.settings.about-box.name.label",
            defaultMessage: "Name (optional)",
            description: "Optional name of that project",
          })}
          vertical={isFlyout}
        >
          <TextInput
            style={{ width: "100%" }}
            type="textarea"
            rows={1}
            text={name ?? ""}
            on_change={async (name) => {
              try {
                await actions.set_project_name(project_id, name);
              } catch (err) {
                setError(`${err}`);
              }
            }}
            onFocus={() => setShowNameInfo(true)}
            onBlur={() => setShowNameInfo(false)}
          />
        </LabeledRow>
        {showNameInfo ? (
          <Alert
            style={{ margin: "0 0 15px 0" }}
            showIcon={false}
            banner={isFlyout}
            title={
              "The project name is currently only used to provide better URL's for publicly shared documents. It can be at most 100 characters long and must be unique among all projects you own. Only the project owner can change the project name.  To be useful, the owner should also set their username in Account Preferences." +
              (name
                ? " TEMPORARY WARNING: If you change the project name, existing links using the previous name will no longer work, so change with caution."
                : "")
            }
            type="info"
          />
        ) : undefined}
        <LabeledRow
          label={intl.formatMessage(labels.starred)}
          vertical={isFlyout}
          style={{ marginBottom: "15px" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Icon
                name={isProjectBookmarked(project_id) ? "star-filled" : "star"}
                style={{
                  color: isProjectBookmarked(project_id)
                    ? COLORS.STAR
                    : COLORS.GRAY,
                  fontSize: "18px",
                  cursor: "pointer",
                }}
                onClick={() =>
                  setProjectBookmarked(
                    project_id,
                    !isProjectBookmarked(project_id),
                  )
                }
              />
              <Typography.Text>
                {isProjectBookmarked(project_id) ? "Enabled" : "Disabled"}
              </Typography.Text>
            </div>
            <HelpIcon title={`${projectLabel} Starring`}>
              {intl.formatMessage(
                {
                  id: "project.settings.about-box.starred.help",
                  defaultMessage:
                    "Starred {projectsLabel} can be filtered by clicking the starred filter button in your {projectsLabel} list.",
                  description:
                    "Help text explaining how project starring works",
                },
                { projectsLabel: projectsLabelLower },
              )}
            </HelpIcon>
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
          showIcon={false}
          showAccentColor={false}
          previewImageUrl={projectImageUrl(appearanceDraft?.image_blob)}
        />
      </>
    );
  }

  if (mode === "flyout") {
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
