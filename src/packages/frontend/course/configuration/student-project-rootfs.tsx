/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";

import { useStore, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import {
  groupedRootfsOptions,
  latestRootfsVersionEntries,
  renderRootfsCatalogOption,
  rootfsOptionSearchText,
  sectionLabel,
  sectionTagColor,
} from "@cocalc/frontend/rootfs/catalog-ui";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { COLORS } from "@cocalc/util/theme";
import type { CourseActions } from "../actions";
import type { CourseStore } from "../store";

interface Props {
  actions: CourseActions;
  name: string;
  settings;
}

export function StudentProjectRootfsConfig({ actions, name, settings }: Props) {
  const store = useStore<CourseStore>({ name });
  const projectMap = useTypedRedux("projects", "project_map");
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [nextImageId, setNextImageId] = useState<string>("");
  const [nextImage, setNextImage] = useState<string>("");
  const currentImage =
    `${settings.get("student_project_rootfs_image") ?? ""}`.trim();
  const currentImageId =
    `${settings.get("student_project_rootfs_image_id") ?? ""}`.trim();
  const courseProjectId = store?.get("course_project_id");
  const inheritedImage =
    `${projectMap?.getIn([courseProjectId, "rootfs_image"]) ?? ""}`.trim();
  const inheritedImageId =
    `${projectMap?.getIn([courseProjectId, "rootfs_image_id"]) ?? ""}`.trim();
  const effectiveCurrentImage = currentImage || inheritedImage;
  const effectiveCurrentImageId =
    currentImageId || (!currentImage ? inheritedImageId : "");
  const existingStudentProjectCount =
    store?.get_student_project_ids().length ?? 0;
  const {
    images: rootfsImages,
    loading: rootfsLoading,
    error: rootfsError,
  } = useRootfsImages([managedRootfsCatalogUrl()]);
  const [showOlderVersions, setShowOlderVersions] = useState<boolean>(false);

  useEffect(() => {
    setNextImage(currentImage);
    setNextImageId(currentImageId);
  }, [currentImage, currentImageId]);

  const visibleRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(
        rootfsImages.filter((entry) => !entry.hidden && !entry.blocked),
        {
          showOlderVersions,
          preserveIds: [effectiveCurrentImageId, nextImageId, inheritedImageId],
        },
      ),
    [
      effectiveCurrentImageId,
      inheritedImageId,
      nextImageId,
      rootfsImages,
      showOlderVersions,
    ],
  );
  const rootfsOptions = useMemo(
    () => groupedRootfsOptions(visibleRootfsImages),
    [visibleRootfsImages],
  );
  const currentEntry = useMemo(() => {
    if (effectiveCurrentImageId) {
      const byId = rootfsImages.find(
        (entry) => entry.id === effectiveCurrentImageId,
      );
      if (byId) return byId;
    }
    if (!effectiveCurrentImage) return undefined;
    return rootfsImages.find((entry) => entry.image === effectiveCurrentImage);
  }, [effectiveCurrentImage, effectiveCurrentImageId, rootfsImages]);
  const nextEntry = useMemo(() => {
    if (nextImageId) {
      const byId = rootfsImages.find((entry) => entry.id === nextImageId);
      if (byId) return byId;
    }
    if (!nextImage) return undefined;
    return rootfsImages.find((entry) => entry.image === nextImage);
  }, [nextImage, nextImageId, rootfsImages]);
  const needSave =
    nextImage.trim() !== currentImage || nextImageId.trim() !== currentImageId;

  function save() {
    actions.configuration.set_student_project_rootfs({
      image: nextImage,
      image_id: nextImageId,
    });
  }

  function confirmApply() {
    const targetEntry = currentEntry;
    const targetLabel = targetEntry?.label?.trim() || effectiveCurrentImage;
    Modal.confirm({
      title: "Apply RootFS image to existing student projects?",
      width: 680,
      okText: `Change ${existingStudentProjectCount} student project${
        existingStudentProjectCount === 1 ? "" : "s"
      }`,
      okButtonProps: { danger: true },
      content: (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {existingStudentProjectCount} existing student project
            {existingStudentProjectCount === 1 ? "" : "s"} will have their
            RootFS image changed to{" "}
            <Typography.Text strong>{targetLabel}</Typography.Text>.
          </Typography.Paragraph>
          <Alert
            type="warning"
            showIcon
            message="This changes the / software environment"
            description={
              <>
                Running student projects will be restarted so the new RootFS
                takes effect immediately. Important student data belongs in
                <Typography.Text code> /root </Typography.Text>
                or
                <Typography.Text code> /scratch </Typography.Text>, not in the
                base RootFS image itself.
              </>
            }
          />
          {targetEntry?.description ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <Typography.Text strong>Image description:</Typography.Text>{" "}
              {targetEntry.description}
            </Typography.Paragraph>
          ) : null}
        </Space>
      ),
      onOk: async () => {
        setApplying(true);
        try {
          await actions.student_projects.set_all_student_project_rootfs();
          message.success(
            `Changed the RootFS image for ${existingStudentProjectCount} student project${
              existingStudentProjectCount === 1 ? "" : "s"
            }.`,
          );
        } finally {
          setApplying(false);
        }
      },
    });
  }

  return (
    <>
      <Card
        title={
          <>
            <Icon name="cube" /> Student Project RootFS Image
          </>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            By default, new student projects use the same RootFS image as this
            instructor project. Set an override here only when this course
            should use a different managed image.
          </Typography.Paragraph>

          <Alert
            type="info"
            showIcon
            message="Why use this?"
            description="Use one managed software environment across all student projects, then roll out upgrades deliberately when you are ready."
          />

          <Form layout="vertical">
            <Form.Item
              label="Managed RootFS image for new student projects"
              style={{ marginBottom: "12px" }}
            >
              <Select
                allowClear
                showSearch
                placeholder="Follow this course project's current RootFS image"
                options={rootfsOptions}
                value={nextImageId || undefined}
                style={{ width: "100%" }}
                listHeight={420}
                filterOption={(input, option) =>
                  rootfsOptionSearchText(option).includes(
                    input.trim().toLowerCase(),
                  )
                }
                optionRender={(option) =>
                  renderRootfsCatalogOption((option.data as any).entry)
                }
                onChange={(value) => {
                  const next = visibleRootfsImages.find(
                    (entry) => entry.id === value,
                  );
                  setNextImage(next?.image ?? "");
                  setNextImageId(next?.id ?? "");
                }}
                loading={rootfsLoading}
                disabled={rootfsLoading}
              />
              <Checkbox
                checked={showOlderVersions}
                onChange={(e) => setShowOlderVersions(e.target.checked)}
              >
                Show older versions
              </Checkbox>
            </Form.Item>
          </Form>

          {nextEntry ? (
            <Space wrap size={[8, 8]}>
              {nextEntry.section ? (
                <Tag color={sectionTagColor(nextEntry.section)}>
                  {sectionLabel(nextEntry.section)}
                </Tag>
              ) : null}
              {nextEntry.version ? <Tag>{nextEntry.version}</Tag> : null}
              {nextEntry.channel ? (
                <Tag color="cyan">{nextEntry.channel}</Tag>
              ) : null}
              {nextEntry.gpu ? <Tag color="purple">GPU image</Tag> : null}
            </Space>
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {currentEntry ? (
                <>
                  No course-specific override is configured. New student
                  projects will use this instructor project&apos;s current
                  RootFS image:
                  <Typography.Text strong>
                    {" "}
                    {currentEntry.label || effectiveCurrentImage}
                  </Typography.Text>
                  .
                </>
              ) : (
                <>
                  No course-specific override is configured. New student
                  projects will follow this instructor project&apos;s current
                  RootFS setting.
                </>
              )}
            </Typography.Paragraph>
          )}

          {currentImage && !currentEntry ? (
            <Alert
              type="warning"
              showIcon
              message="Configured image is no longer visible in the catalog"
              description={`The course is currently configured to use ${currentImage}. Save a new selection to replace it.`}
            />
          ) : null}

          {rootfsError ? (
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0, color: COLORS.GRAY_D }}
            >
              Catalog load issue: {rootfsError}
            </Typography.Paragraph>
          ) : null}

          <Space wrap>
            <Button
              type={needSave ? "primary" : "default"}
              disabled={!needSave}
              onClick={save}
            >
              Save
            </Button>
            <Button
              disabled={
                needSave ||
                applying ||
                !effectiveCurrentImage ||
                existingStudentProjectCount === 0
              }
              onClick={confirmApply}
            >
              {applying ? (
                <Icon name="cocalc-ring" spin />
              ) : (
                <Icon name="refresh" />
              )}{" "}
              Apply To Existing Student Projects...
            </Button>
            <Button type="link" onClick={() => setHelpOpen(true)}>
              What does this change?
            </Button>
          </Space>

          {needSave ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Save this course setting before applying it to existing student
              projects.
            </Typography.Paragraph>
          ) : null}
        </Space>
      </Card>
      <Modal
        open={helpOpen}
        footer={null}
        onCancel={() => setHelpOpen(false)}
        title="How course RootFS images work"
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="New student projects"
            description="If you leave this unset, new student projects use the same RootFS image as the instructor project that contains this .course file. If you set an override here, that managed image is used instead."
          />
          <Alert
            type="warning"
            showIcon
            message="Existing student projects"
            description="Existing student projects do not change automatically. Use “Apply To Existing Student Projects...” when you want to switch them."
          />
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Changing the RootFS image switches the project&apos;s visible
            <Typography.Text code> / </Typography.Text>
            software environment. That is appropriate for managed software and
            base filesystem customizations, but not for important long-term
            data.
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Tell students to treat
            <Typography.Text code> /root </Typography.Text>
            as the place for long-term project data and configuration, and
            <Typography.Text code> /scratch </Typography.Text>
            as ephemeral workspace storage.
          </Typography.Paragraph>
        </Space>
      </Modal>
    </>
  );
}
