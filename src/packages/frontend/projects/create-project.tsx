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
  Popover,
  Space,
  Tag,
  Typography,
} from "antd";
import { delay } from "awaiting";
import { useIntl } from "react-intl";

import {
  redux,
  useEffect,
  useIsMountedRef,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Icon, Paragraph } from "@cocalc/frontend/components";
import { cocalc_setup_profile } from "@cocalc/frontend/components/constants";
import { labels } from "@cocalc/frontend/i18n";

import { R2_REGION_LABELS } from "@cocalc/util/consts";
import { COLORS } from "@cocalc/util/theme";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { RootfsScanSummaryButton } from "@cocalc/frontend/rootfs/scan-status";
import {
  latestRootfsVersionEntries,
  renderRootfsCatalogOption,
  sectionLabel,
  sectionTagColor,
} from "@cocalc/frontend/rootfs/catalog-ui";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { isNewProjectRootfsSelectable } from "./create-project-rootfs";
import {
  type ProjectCreateMode,
  projectDraftToCreateOptions,
} from "./create/project-create-draft";
import { ProjectCreateHealthCard } from "./create/project-create-health-card";
import { useProjectCreateDraft } from "./create/use-project-create-draft";
import "./create-project.css";

const IS_STAR_SETUP_PROFILE = cocalc_setup_profile === "star";

interface Props {
  default_value: string;
  open: boolean;
  onClose: () => void;
}

const PROJECT_PRESETS: {
  mode: ProjectCreateMode;
  title: string;
  description: string;
}[] = [
  {
    mode: "standard",
    title: "Standard",
    description: "General-purpose image, automatic host.",
  },
  {
    mode: "gpu",
    title: "GPU",
    description: "GPU-tagged image when one is available.",
  },
  {
    mode: "teaching",
    title: "Teaching",
    description: "Teaching-tagged image for classes and workshops.",
  },
  {
    mode: "custom",
    title: "Custom",
    description: "Choose your own image and host.",
  },
];

function projectPresetDescription(preset: (typeof PROJECT_PRESETS)[number]) {
  if (!IS_STAR_SETUP_PROFILE) return preset.description;
  switch (preset.mode) {
    case "standard":
      return "General-purpose image.";
    case "custom":
      return "Choose your own image.";
    default:
      return preset.description;
  }
}

export function NewProjectCreator({ default_value, open, onClose }: Props) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();

  const [error, set_error] = useState<string>("");
  const [createAction, setCreateAction] = useState<"create" | "open" | null>(
    null,
  );
  const [titlePreview, setTitlePreview] = useState<string>(default_value);
  const saving = createAction != null;
  const new_project_title_ref = useRef<any>(null);
  const [showOlderRootfsVersions, setShowOlderRootfsVersions] =
    useState<boolean>(false);
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsSearch, setRootfsSearch] = useState("");
  const {
    draft,
    summary,
    rootfsImages,
    rootfsLoading,
    rootfsError,
    isAdmin,
    selectedHost,
    setHost,
    setRootfs,
    applyPreset,
    reset,
  } = useProjectCreateDraft({
    defaultValue: default_value,
  });

  const [form] = Form.useForm();
  const isGpu = summary.gpu;
  const filteredRootfsImages = useMemo(
    () =>
      rootfsImages.filter((entry) => {
        return isNewProjectRootfsSelectable({ entry, isGpu, isAdmin });
      }),
    [rootfsImages, isGpu, isAdmin],
  );
  const pickerRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(filteredRootfsImages, {
        showOlderVersions: showOlderRootfsVersions,
        preserveIds: [draft.rootfs_image_id],
      }),
    [draft.rootfs_image_id, filteredRootfsImages, showOlderRootfsVersions],
  );
  const visibleRootfsImages = useMemo(() => {
    const query = rootfsSearch.trim().toLowerCase();
    if (!query) return pickerRootfsImages;
    return pickerRootfsImages.filter((entry) =>
      rootfsEntrySearchText(entry).includes(query),
    );
  }, [pickerRootfsImages, rootfsSearch]);
  const selectedRootfsEntry = useMemo(() => {
    const imageId = draft.rootfs_image_id?.trim();
    if (imageId) {
      return filteredRootfsImages.find((entry) => entry.id === imageId);
    }
    const image = draft.rootfs_image?.trim();
    if (!image) return undefined;
    return filteredRootfsImages.find((entry) => entry.image === image);
  }, [draft.rootfs_image, draft.rootfs_image_id, filteredRootfsImages]);
  useEffect(() => {
    if (!open) {
      return;
    }
    form.setFieldsValue({ title: draft.title });
    setTitlePreview(draft.title);
  }, [draft.title, form, open]);

  const is_mounted_ref = useIsMountedRef();

  async function select_text(): Promise<void> {
    // wait for next render loop so the title actually is in the DOM...
    await delay(1);
    (new_project_title_ref.current as any)?.input?.select();
  }

  function reset_form(): void {
    reset();
    setTitlePreview(draft.title);
    set_error("");
    setCreateAction(null);
    setRootfsMode("catalog");
    setRootfsDraft("");
    setRootfsSearch("");
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

  async function create_project({
    openAfterCreate,
  }: {
    openAfterCreate: boolean;
  }): Promise<void> {
    setCreateAction(openAfterCreate ? "open" : "create");
    const actions = redux.getActions("projects");
    let project_id: string;
    const title =
      `${(new_project_title_ref.current as any)?.input?.value ?? draft.title}`.trim();
    if (!title) {
      setCreateAction(null);
      set_error(`Please enter a title for the new ${projectLabelLower}.`);
      return;
    }
    if (!draft.rootfs_image.trim()) {
      setCreateAction(null);
      set_error("Please choose an image for the new project.");
      return;
    }
    const opts = projectDraftToCreateOptions({
      ...draft,
      title,
      start: openAfterCreate,
    });
    try {
      project_id = await actions.create_project(opts);
    } catch (err) {
      if (!is_mounted_ref.current) return;
      setCreateAction(null);
      set_error(`Error creating ${projectLabelLower} -- ${err}`);
      return;
    }

    if (openAfterCreate) {
      // switch_to=true is perhaps suggested by #4088
      actions.open_project({
        project_id,
        target: "files/",
        switch_to: true,
      });
    }
    cancel_editing();
  }

  function render_error(): React.JSX.Element | undefined {
    if (!error) return;
    return <ErrorDisplay error={error} onClose={() => set_error("")} />;
  }

  function isDisabled() {
    return saving || !summary.rootfs_image.trim();
  }

  function handle_keypress(e): void {
    if (e.keyCode === 27) {
      cancel_editing();
    } else if (e.keyCode === 13) {
      create_project({ openAfterCreate: true });
    }
  }

  function applyCustomRootfsDraft() {
    const trimmed = rootfsDraft.trim();
    if (!isAdmin) {
      set_error("Only admins can use advanced OCI images.");
      return;
    }
    setRootfs({ image: trimmed });
    setRootfsMode("catalog");
  }

  function renderRootfsHelp(): React.JSX.Element {
    return (
      <Space orientation="vertical" size="small" style={{ maxWidth: 420 }}>
        <Paragraph style={{ marginBottom: 0 }}>
          An image defines the software installed in the project.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Choose SageMath for Sage/Python/math work, R for R projects, GPU
          images for CUDA workloads, and minimal images only when you want a
          small base to customize yourself.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Managed catalog images are recommended.
        </Paragraph>
      </Space>
    );
  }

  function renderRootfsCatalogSelector(): React.JSX.Element {
    return (
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Input.Search
          allowClear
          value={rootfsSearch}
          placeholder="Search images, e.g. SageMath, R, Python, GPU..."
          onChange={(e) => setRootfsSearch(e.target.value)}
          disabled={saving || rootfsLoading}
        />
        <div className="cc-project-create-image-list">
          {visibleRootfsImages.map((entry) => {
            const selected =
              entry.id === draft.rootfs_image_id ||
              entry.image === draft.rootfs_image;
            return (
              <button
                key={entry.id}
                type="button"
                className="cc-project-create-image-option"
                aria-pressed={selected}
                disabled={saving}
                onClick={() =>
                  setRootfs({ image: entry.image, image_id: entry.id })
                }
              >
                {renderRootfsCatalogOption(entry)}
              </button>
            );
          })}
          {!rootfsLoading && visibleRootfsImages.length === 0 && (
            <Paragraph type="secondary" style={{ margin: 0, padding: 12 }}>
              No matching images. Try a different search.
            </Paragraph>
          )}
          {rootfsLoading && visibleRootfsImages.length === 0 && (
            <Paragraph type="secondary" style={{ margin: 0, padding: 12 }}>
              Loading images...
            </Paragraph>
          )}
        </div>
        <Space wrap>
          <Checkbox
            checked={showOlderRootfsVersions}
            onChange={(e) => setShowOlderRootfsVersions(e.target.checked)}
            disabled={saving}
          >
            Show older versions
          </Checkbox>
          {isAdmin && (
            <Button
              type="link"
              onClick={() => setRootfsMode("custom")}
              style={{ paddingLeft: 0, width: "fit-content" }}
              disabled={saving}
            >
              Advanced OCI / Docker image
            </Button>
          )}
        </Space>
        {rootfsError && (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Catalog load issue: {rootfsError}
          </Paragraph>
        )}
      </Space>
    );
  }

  function renderCustomRootfsSelector(): React.JSX.Element {
    return (
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Alert
          type="warning"
          showIcon
          message="Advanced OCI / Docker image"
          description={
            <>
              This bypasses the managed catalog. Some raw OCI images will break
              parts of CoCalc if they are missing expected runtime packages such
              as certificates or a normal shell/userland.
            </>
          }
        />
        <Input
          value={rootfsDraft}
          placeholder="docker.io/library/ubuntu:24.04"
          onChange={(e) => setRootfsDraft(e.target.value)}
          disabled={saving}
        />
        <Space wrap>
          <Button
            type="primary"
            onClick={applyCustomRootfsDraft}
            disabled={saving || !rootfsDraft.trim()}
          >
            Use this image
          </Button>
          <Button onClick={() => setRootfsMode("catalog")} disabled={saving}>
            Back to catalog images
          </Button>
        </Space>
      </Space>
    );
  }

  function renderRootfsSection(): React.JSX.Element {
    const displayImage = draft.rootfs_image?.trim() || "";
    const displayLabel =
      selectedRootfsEntry?.label || displayImage || "No image selected";
    return (
      <Card
        size="small"
        styles={{ body: { padding: "10px 12px" } }}
        style={{ borderColor: COLORS.GRAY_LL }}
      >
        <Space orientation="vertical" size={6} style={{ width: "100%" }}>
          <Space
            align="center"
            style={{ width: "100%", justifyContent: "space-between" }}
            wrap
          >
            <Space size="middle" wrap>
              <span
                style={{
                  alignItems: "center",
                  background: COLORS.YELL_LLL,
                  borderRadius: 10,
                  color: COLORS.YELL_D,
                  display: "inline-flex",
                  height: 32,
                  justifyContent: "center",
                  width: 32,
                }}
              >
                <Icon name="cube" />
              </span>
              <span>
                <div style={{ fontWeight: 700, color: COLORS.GRAY_D }}>
                  Image
                  <Popover content={renderRootfsHelp()} trigger="click">
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: "0 0 0 6px", height: "auto" }}
                    >
                      What should I choose?
                    </Button>
                  </Popover>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {displayLabel}
                </Typography.Text>
              </span>
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
              {!selectedRootfsEntry && displayImage && (
                <Tag color={isAdmin ? "orange" : "red"}>
                  {isAdmin ? "Advanced OCI" : "Unavailable image"}
                </Tag>
              )}
            </Space>
            <Space size={4} wrap className="cc-project-create-preset-tags">
              {PROJECT_PRESETS.map((preset) => {
                const active = draft.mode === preset.mode;
                return (
                  <button
                    key={preset.mode}
                    type="button"
                    className="cc-project-create-preset-tag"
                    aria-pressed={active}
                    title={projectPresetDescription(preset)}
                    disabled={saving}
                    onClick={() => applyPreset(preset.mode)}
                    style={{
                      borderColor: active
                        ? COLORS.BS_BLUE_BGRND
                        : COLORS.GRAY_LL,
                      background: active ? COLORS.ANTD_BG_BLUE_L : "white",
                      color: active ? COLORS.BS_BLUE_TEXT : COLORS.GRAY_D,
                      boxShadow: active
                        ? `0 0 0 1px ${COLORS.BS_BLUE_BGRND} inset`
                        : undefined,
                    }}
                  >
                    {preset.mode}
                  </button>
                );
              })}
            </Space>
          </Space>
          {!selectedRootfsEntry && displayImage && (
            <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              {displayImage}
            </code>
          )}
          {selectedRootfsEntry && renderRootfsWarning(selectedRootfsEntry)}
          {selectedRootfsEntry && (
            <RootfsScanSummaryButton
              entry={selectedRootfsEntry}
              title={`Image scan details: ${selectedRootfsEntry.label}`}
            />
          )}
          {rootfsMode === "catalog"
            ? renderRootfsCatalogSelector()
            : renderCustomRootfsSelector()}
        </Space>
      </Card>
    );
  }

  function renderSummarySection(): React.JSX.Element {
    const title =
      `${(new_project_title_ref.current as any)?.input?.value ?? titlePreview}`.trim() ||
      "Untitled project";
    const summaryItems = [
      {
        icon: "project-outlined",
        label: "Project name",
        value: title,
        color: COLORS.ANTD_BG_BLUE_L,
      },
      {
        icon: "sliders",
        label: "Preset",
        value: presetTitle(draft.mode),
        color: COLORS.GRAY_LLL,
      },
      {
        icon: "cube",
        label: "Image",
        value: summary.rootfsLabel,
        color: COLORS.YELL_LLL,
      },
      {
        icon: "servers",
        label: "Host / region",
        value: summary.hostName || summary.host_id || "Automatic placement",
        color: COLORS.BS_GREEN_LL,
        hidden: IS_STAR_SETUP_PROFILE,
      },
      {
        icon: "database",
        label: "Backups",
        value: R2_REGION_LABELS[draft.region],
        color: COLORS.GRAY_LLL,
      },
    ];
    return (
      <Card
        size="small"
        styles={{ body: { padding: 16 } }}
        className="cc-project-create-summary-card"
        style={{
          borderColor: COLORS.GRAY_LL,
          background: "white",
        }}
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Project summary</div>
          </div>
          <Space orientation="vertical" size={0} style={{ width: "100%" }}>
            {summaryItems
              .filter((item) => !item.hidden)
              .map((item, index, visibleItems) => (
                <div
                  key={item.label}
                  className="cc-project-create-summary-row"
                  style={{
                    borderBottom:
                      index === visibleItems.length - 1
                        ? undefined
                        : `1px solid ${COLORS.GRAY_LL}`,
                  }}
                >
                  <span
                    className="cc-project-create-summary-icon"
                    style={{
                      background: item.color,
                      color: COLORS.BS_BLUE_TEXT,
                    }}
                  >
                    <Icon name={item.icon as any} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
                      {item.label}
                    </div>
                    <div
                      style={{
                        color: COLORS.GRAY_D,
                        fontSize: 13,
                        fontWeight: 600,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {item.value}
                    </div>
                  </span>
                </div>
              ))}
          </Space>
          <Space wrap>
            {summary.gpu && <Tag color="purple">GPU</Tag>}
            {selectedRootfsEntry?.section && (
              <Tag color={sectionTagColor(selectedRootfsEntry.section)}>
                {sectionLabel(selectedRootfsEntry.section)}
              </Tag>
            )}
            {selectedRootfsEntry?.warning && <Tag color="orange">Review</Tag>}
            {!selectedRootfsEntry && summary.rootfs_image && (
              <Tag color={isAdmin ? "orange" : "red"}>
                {isAdmin ? "Advanced OCI" : "Unavailable image"}
              </Tag>
            )}
          </Space>
          {summary.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={summary.warnings.join(" ")}
            />
          )}
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Button
              type="primary"
              block
              onClick={() => create_project({ openAfterCreate: true })}
              disabled={isDisabled()}
              loading={createAction === "open"}
              icon={<Icon name="arrow-right" />}
            >
              Create and Open
            </Button>
            <Button
              block
              onClick={() => create_project({ openAfterCreate: false })}
              disabled={isDisabled()}
              loading={createAction === "create"}
              icon={<Icon name="plus-circle" />}
            >
              Create Project
            </Button>
            <Button block onClick={cancel_editing} disabled={saving}>
              {intl.formatMessage(labels.cancel)}
            </Button>
          </Space>
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
      <Space
        orientation="vertical"
        size={10}
        className="cc-project-create-form-column"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label={
              <span style={{ fontWeight: 700 }}>
                {intl.formatMessage(labels.title)}
              </span>
            }
            name="title"
            style={{ marginBottom: 0 }}
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
              onKeyDown={handle_keypress}
              onChange={(e) => setTitlePreview(e.target.value)}
              autoFocus
            />
          </Form.Item>
        </Form>
        {renderRootfsSection()}
        {!IS_STAR_SETUP_PROFILE && (
          <SelectNewHost
            disabled={saving}
            selectedHost={selectedHost}
            onChange={setHost}
            regionFilter={draft.region}
            regionLabel={R2_REGION_LABELS[draft.region]}
            wantsGpu={summary.gpu}
            pickerMode="create"
            pickerDisplay="modal"
            showHelp={false}
          />
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
    <Modal
      open={open}
      destroyOnHidden
      className="cc-project-create-modal"
      width="min(1180px, 96vw)"
      title={
        <Space size="middle" align="start">
          <span
            className="cc-project-create-title-icon"
            style={{
              background: COLORS.ANTD_BG_BLUE_L,
              color: COLORS.BS_BLUE_TEXT,
            }}
          >
            <Icon name="plus-circle" />
          </span>
          <span>
            <div className="cc-project-create-title">
              {intl.formatMessage(labels.create_project)}
            </div>
            <Typography.Text
              type="secondary"
              className="cc-project-create-subtitle"
            >
              Pick a good default now. Everything can be changed later.
            </Typography.Text>
          </span>
        </Space>
      }
      onCancel={cancel_editing}
      footer={null}
      maskClosable={!saving}
      styles={{
        body: {
          background: COLORS.GRAY_LLL,
          maxHeight: "min(780px, 88vh)",
          overflowY: "auto",
          padding: 14,
        },
      }}
    >
      <div className="cc-project-create-body">
        <ProjectCreateHealthCard open={open} />
        <div className="cc-project-create-content-grid">
          {render_input_section()}
          {renderSummarySection()}
        </div>
      </div>
    </Modal>
  );
}

function presetTitle(mode: ProjectCreateMode): string {
  return PROJECT_PRESETS.find((preset) => preset.mode === mode)?.title ?? mode;
}

function rootfsEntrySearchText(entry: RootfsImageEntry): string {
  return [
    entry.label,
    entry.image,
    entry.description,
    entry.theme?.title,
    entry.theme?.description,
    entry.section,
    entry.version,
    entry.channel,
    entry.owner_name,
    "rootfs",
    ...(entry.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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
