/*
 *  This file is part of CoCalc: Copyright (c) 2020 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Create a new project
*/

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { delay } from "awaiting";
import { FormattedMessage, useIntl } from "react-intl";

import {
  redux,
  useEffect,
  useIsMountedRef,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { A, ErrorDisplay, Icon, Paragraph } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";

import {
  R2_REGION_LABELS,
  R2_REGIONS,
  type R2Region,
} from "@cocalc/util/consts";
import { capitalize } from "@cocalc/util/misc";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { RootfsScanStatus } from "@cocalc/frontend/rootfs/scan-status";
import {
  groupedRootfsOptions,
  latestRootfsVersionEntries,
  renderRootfsCatalogOption,
  rootfsOptionSearchText,
  sectionLabel,
  sectionTagColor,
} from "@cocalc/frontend/rootfs/catalog-ui";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { isNewProjectRootfsSelectable } from "./create-project-rootfs";
import { projectDraftToCreateOptions } from "./create/project-create-draft";
import { useProjectCreateDraft } from "./create/use-project-create-draft";

interface Props {
  default_value: string;
  open: boolean;
  onClose: () => void;
}

export function NewProjectCreator({ default_value, open, onClose }: Props) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabel = intl.formatMessage(labels.projects);
  const { Title } = Typography;

  const [error, set_error] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const new_project_title_ref = useRef<any>(null);
  const [rootfsModalOpen, setRootfsModalOpen] = useState<boolean>(false);
  const [showOlderRootfsVersions, setShowOlderRootfsVersions] =
    useState<boolean>(false);
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsDraftId, setRootfsDraftId] = useState<string | undefined>();
  const {
    draft,
    summary,
    rootfsImages,
    rootfsLoading,
    rootfsError,
    isAdmin,
    selectedHost,
    setTitle,
    setAdvancedOpen,
    setRegion,
    setHost,
    setRootfs,
    reset,
  } = useProjectCreateDraft({ defaultValue: default_value });
  const regionOptions = useMemo(
    () =>
      R2_REGIONS.map((region) => ({
        value: region,
        label: R2_REGION_LABELS[region],
      })),
    [],
  );

  const [form] = Form.useForm();
  const isGpu = summary.gpu;
  const filteredRootfsImages = useMemo(
    () =>
      rootfsImages.filter((entry) => {
        return isNewProjectRootfsSelectable({ entry, isGpu });
      }),
    [rootfsImages, isGpu],
  );
  const pickerRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(filteredRootfsImages, {
        showOlderVersions: showOlderRootfsVersions,
        preserveIds: [rootfsDraftId, draft.rootfs_image_id],
      }),
    [
      draft.rootfs_image_id,
      filteredRootfsImages,
      rootfsDraftId,
      showOlderRootfsVersions,
    ],
  );
  const selectedRootfsEntry = useMemo(() => {
    const imageId = draft.rootfs_image_id?.trim();
    if (imageId) {
      return rootfsImages.find((entry) => entry.id === imageId);
    }
    const image = draft.rootfs_image?.trim();
    if (!image) return undefined;
    return rootfsImages.find((entry) => entry.image === image);
  }, [draft.rootfs_image, draft.rootfs_image_id, rootfsImages]);
  const rootfsGroupedOptions = useMemo(
    () => groupedRootfsOptions(pickerRootfsImages),
    [pickerRootfsImages],
  );

  useEffect(() => {
    form.setFieldsValue({ title: draft.title });
  }, [draft.title, form]);

  const is_mounted_ref = useIsMountedRef();

  async function select_text(): Promise<void> {
    // wait for next render loop so the title actually is in the DOM...
    await delay(1);
    (new_project_title_ref.current as any)?.input?.select();
  }

  function reset_form(): void {
    reset();
    set_error("");
    setSaving(false);
    setRootfsModalOpen(false);
    setRootfsMode("catalog");
    setRootfsDraft("");
    setRootfsDraftId(undefined);
  }

  function start_editing(): void {
    reset_form();
    select_text();
  }

  function cancel_editing(): void {
    if (!is_mounted_ref.current) return;
    reset_form();
    onClose();
  }

  async function create_project(): Promise<void> {
    setSaving(true);
    const actions = redux.getActions("projects");
    let project_id: string;
    const opts = projectDraftToCreateOptions(draft);
    try {
      project_id = await actions.create_project(opts);
    } catch (err) {
      if (!is_mounted_ref.current) return;
      setSaving(false);
      setAdvancedOpen(true);
      set_error(`Error creating ${projectLabelLower} -- ${err}`);
      return;
    }

    // switch_to=true is perhaps suggested by #4088
    actions.open_project({
      project_id,
      target: "project-home",
      switch_to: true,
    });
    cancel_editing();
  }

  function render_error(): React.JSX.Element | undefined {
    if (!error) return;
    return <ErrorDisplay error={error} onClose={() => set_error("")} />;
  }

  function isDisabled() {
    return (
      // no name of new project
      !draft.title?.trim() ||
      // currently saving (?)
      saving
    );
  }

  function input_on_change(): void {
    const text = (new_project_title_ref.current as any)?.input?.value;
    setTitle(text);
  }

  function handle_keypress(e): void {
    if (e.keyCode === 27) {
      cancel_editing();
    } else if (e.keyCode === 13 && draft.title !== "") {
      create_project();
    }
  }

  function openRootfsModal() {
    const current = (draft.rootfs_image?.trim() ||
      DEFAULT_PROJECT_IMAGE) as string;
    setRootfsDraft(current);
    const currentEntry =
      filteredRootfsImages.find(
        (entry) => entry.id === draft.rootfs_image_id,
      ) ?? filteredRootfsImages.find((entry) => entry.image === current);
    setRootfsDraftId(currentEntry?.id);
    const isCatalog = !!currentEntry || !isAdmin;
    setRootfsMode(isCatalog ? "catalog" : "custom");
    setRootfsModalOpen(true);
  }

  function renderRootfsModal() {
    if (!rootfsModalOpen) return null;
    const activeEntry =
      filteredRootfsImages.find((entry) => entry.id === rootfsDraftId) ??
      filteredRootfsImages.find((entry) => entry.image === rootfsDraft);
    return (
      <Modal
        open
        width={720}
        title="Root Filesystem Software Image"
        onCancel={() => setRootfsModalOpen(false)}
        onOk={() => {
          const trimmed = rootfsDraft.trim();
          if (rootfsMode === "custom") {
            setRootfs({ image: trimmed || DEFAULT_PROJECT_IMAGE });
          } else {
            const nextEntry =
              filteredRootfsImages.find(
                (entry) => entry.id === rootfsDraftId,
              ) ??
              filteredRootfsImages.find((entry) => entry.image === rootfsDraft);
            setRootfs({
              image: nextEntry?.image || draft.rootfs_image,
              image_id: nextEntry?.id,
            });
          }
          setRootfsModalOpen(false);
        }}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Pick a managed RootFS image for this project. You can always change
            it later in project settings.
          </Paragraph>
          {rootfsMode === "catalog" ? (
            <>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Managed catalog images are the recommended path. They carry
                visibility, publishing, scanning, and lifecycle metadata.
              </Paragraph>
              <Select
                showSearch
                options={rootfsGroupedOptions}
                value={rootfsDraftId}
                placeholder="Select an image"
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
                  const next = filteredRootfsImages.find(
                    (entry) => entry.id === value,
                  );
                  setRootfsDraft(next?.image || "");
                  setRootfsDraftId(next?.id);
                }}
                loading={rootfsLoading}
                disabled={rootfsLoading}
              />
              <Checkbox
                checked={showOlderRootfsVersions}
                onChange={(e) => setShowOlderRootfsVersions(e.target.checked)}
              >
                Show older versions
              </Checkbox>
              {isAdmin && (
                <Button
                  type="link"
                  onClick={() => setRootfsMode("custom")}
                  style={{ paddingLeft: 0, width: "fit-content" }}
                >
                  Use an advanced OCI or Docker image instead
                </Button>
              )}
              {activeEntry?.description && (
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {activeEntry.description}
                </Paragraph>
              )}
              {activeEntry && renderRootfsWarning(activeEntry)}
              {activeEntry && <RootfsScanStatus entry={activeEntry} />}
              <Space wrap>
                {activeEntry?.section && (
                  <Tag color={sectionTagColor(activeEntry.section)}>
                    {sectionLabel(activeEntry.section)}
                  </Tag>
                )}
                {activeEntry?.version && <Tag>{activeEntry.version}</Tag>}
                {activeEntry?.channel && (
                  <Tag color="cyan">{activeEntry.channel}</Tag>
                )}
                {activeEntry?.gpu && <Tag color="purple">GPU image</Tag>}
                {activeEntry?.owner_name && activeEntry.section !== "mine" && (
                  <Tag>{activeEntry.owner_name}</Tag>
                )}
              </Space>
              {rootfsError && (
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  Catalog load issue: {rootfsError}
                </Paragraph>
              )}
            </>
          ) : (
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              <Alert
                type="warning"
                showIcon
                title="Advanced OCI / Docker image"
                description={
                  <>
                    This bypasses the managed catalog. Some raw OCI images will
                    break parts of CoCalc if they are missing expected runtime
                    packages such as certificates or a normal shell/userland.
                  </>
                }
              />
              <Input
                value={rootfsDraft}
                placeholder="docker.io/library/ubuntu:24.04"
                onChange={(e) => {
                  setRootfsDraft(e.target.value);
                  setRootfsDraftId(undefined);
                }}
              />
              <Button
                type="link"
                onClick={() => setRootfsMode("catalog")}
                style={{ paddingLeft: 0, width: "fit-content" }}
              >
                Back to managed catalog images
              </Button>
            </Space>
          )}
        </Space>
      </Modal>
    );
  }

  function renderRootfsSection(): React.JSX.Element {
    const displayImage = draft.rootfs_image?.trim() || DEFAULT_PROJECT_IMAGE;
    const displayLabel =
      selectedRootfsEntry?.label || displayImage || DEFAULT_PROJECT_IMAGE;
    return (
      <Card size="small" styles={{ body: { padding: "10px 12px" } }}>
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <div style={{ fontWeight: 600 }}>Root Filesystem Software Image</div>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Select the base root filesystem image for this project.
          </Paragraph>
          <Space wrap>
            <Button onClick={openRootfsModal} disabled={saving}>
              Choose image...
            </Button>
            <Tag color="blue">{displayLabel}</Tag>
            {selectedRootfsEntry?.section && (
              <Tag color={sectionTagColor(selectedRootfsEntry.section)}>
                {sectionLabel(selectedRootfsEntry.section)}
              </Tag>
            )}
            {selectedRootfsEntry?.version && (
              <Tag>{selectedRootfsEntry.version}</Tag>
            )}
            {selectedRootfsEntry?.channel && (
              <Tag color="cyan">{selectedRootfsEntry.channel}</Tag>
            )}
            {selectedRootfsEntry?.gpu && <Tag color="purple">GPU</Tag>}
            {!selectedRootfsEntry && <Tag color="orange">Advanced OCI</Tag>}
          </Space>
          {displayImage && (
            <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              {displayImage}
            </code>
          )}
          {selectedRootfsEntry && renderRootfsWarning(selectedRootfsEntry)}
          {selectedRootfsEntry && (
            <RootfsScanStatus entry={selectedRootfsEntry} />
          )}
          {renderRootfsModal()}
        </Space>
      </Card>
    );
  }

  function render_input_section(): React.JSX.Element | undefined {
    const helpTxt = intl.formatMessage({
      id: "projects.create-project.helpTxt",
      defaultMessage: "Pick a title. You can easily change it later!",
    });

    return (
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Form form={form} layout="vertical">
          <Form.Item
            label={intl.formatMessage(labels.title)}
            name="title"
            initialValue={draft.title}
            rules={[
              {
                required: true,
                min: 1,
                message: helpTxt,
              },
            ]}
          >
            <Input
              ref={new_project_title_ref}
              placeholder={`Name your new ${projectLabelLower}...`}
              disabled={saving}
              onChange={input_on_change}
              onKeyDown={handle_keypress}
              autoFocus
            />
          </Form.Item>
        </Form>
        {renderRootfsSection()}
        <Button
          type="link"
          onClick={() => setAdvancedOpen(!draft.advanced_open)}
          style={{ paddingLeft: 0 }}
        >
          {draft.advanced_open ? "Hide advanced" : "Show advanced"}
        </Button>
        {draft.advanced_open && (
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Paragraph type="secondary">
              <FormattedMessage
                id="projects.create-project.explanation"
                defaultMessage={`A <A1>{projectLabel}</A1> is a private computational environment
                  where you can work with collaborators that you explicitly invite.`}
                values={{
                  projectLabel: projectLabelLower,
                  A1: (c) => (
                    <A href="https://doc.cocalc.com/project.html">{c}</A>
                  ),
                }}
              />
            </Paragraph>
            <Card size="small" styles={{ body: { padding: "10px 12px" } }}>
              <Space
                orientation="vertical"
                size="small"
                style={{ width: "100%" }}
              >
                <div style={{ fontWeight: 600 }}>Backup region</div>
                <Select
                  value={draft.region}
                  onChange={(value) => setRegion(value as R2Region)}
                  options={regionOptions}
                  disabled={saving}
                />
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  Backups are stored in this region. {projectsLabel} can only
                  run on hosts in the same region.
                </Paragraph>
              </Space>
            </Card>
            <SelectNewHost
              disabled={saving}
              selectedHost={selectedHost}
              onChange={setHost}
              regionFilter={draft.region}
              regionLabel={R2_REGION_LABELS[draft.region]}
              pickerMode="create"
            />
          </Space>
        )}
        {render_error()}
      </Space>
    );
  }

  useEffect(() => {
    if (open) {
      start_editing();
    } else {
      reset_form();
    }
  }, [open]);

  if (!open) return null;

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          {intl.formatMessage(labels.create_project)}
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Pick a title now and tune the rest later.
        </Paragraph>
      </div>
      {render_input_section()}
      <Space>
        <Button onClick={cancel_editing} disabled={saving}>
          {intl.formatMessage(labels.cancel)}
        </Button>
        <Button
          type="primary"
          onClick={create_project}
          disabled={isDisabled()}
          loading={saving}
          icon={<Icon name="plus-circle" />}
        >
          {capitalize(intl.formatMessage(labels.create))}
        </Button>
      </Space>
    </Space>
  );
}

function renderRootfsWarning(
  entry: RootfsImageEntry,
): React.JSX.Element | undefined {
  if (entry.warning === "collaborator") {
    return (
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        This image was published by one of your collaborators. Review it before
        using it in shared or teaching projects.
      </Paragraph>
    );
  }
  if (entry.warning === "public") {
    return (
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        This is a public community image. It may be slow, unsupported, or unsafe
        for general use.
      </Paragraph>
    );
  }
}
