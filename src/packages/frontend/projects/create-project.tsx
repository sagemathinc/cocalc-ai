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
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import {
  latestRootfsVersionEntries,
  sectionLabel,
  sectionTagColor,
} from "@cocalc/frontend/rootfs/catalog-ui";
import { RootfsCatalogPicker } from "@cocalc/frontend/rootfs/catalog-picker";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { isNewProjectRootfsSelectable } from "./create-project-rootfs";
import {
  type ProjectCreateMode,
  projectDraftToCreateOptions,
  rootfsEntryMatchesProjectMode,
} from "./create/project-create-draft";
import { ProjectCreateHealthCard } from "./create/project-create-health-card";
import { useProjectCreateDraft } from "./create/use-project-create-draft";
import { useProjectRuntimeCapabilities } from "@cocalc/frontend/project/runtime-capabilities";
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
    description: "General-purpose CPU images; automatic host placement.",
  },
  {
    mode: "gpu",
    title: "GPU",
    description: "GPU-ready software; requires a GPU project host.",
  },
  {
    mode: "teaching",
    title: "Teaching",
    description: "Images curated for classes and workshops.",
  },
  {
    mode: "custom",
    title: "All images",
    description: "All compatible images; choose the host yourself.",
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
  const runtime = useProjectRuntimeCapabilities();
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
    setTitle,
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
        return (
          rootfsEntryMatchesProjectMode(entry, draft.mode) &&
          isNewProjectRootfsSelectable({ entry, isGpu, isAdmin })
        );
      }),
    [draft.mode, rootfsImages, isGpu, isAdmin],
  );
  const pickerRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(filteredRootfsImages, {
        showOlderVersions: showOlderRootfsVersions,
        preserveIds: [draft.rootfs_image_id],
      }),
    [draft.rootfs_image_id, filteredRootfsImages, showOlderRootfsVersions],
  );
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
  const titleIsMissing = !draft.title.trim();

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
    if (runtime.rootfs && !draft.rootfs_image.trim()) {
      setCreateAction(null);
      set_error("Please choose an image for the new project.");
      return;
    }
    const opts = projectDraftToCreateOptions({
      ...draft,
      title,
      start: openAfterCreate,
    });
    if (!runtime.rootfs) {
      delete opts.rootfs_image;
      delete opts.rootfs_image_id;
    }
    if (!runtime.host_placement) {
      delete opts.host_id;
    }
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
    return (
      saving ||
      titleIsMissing ||
      (runtime.rootfs && !summary.rootfs_image.trim())
    );
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

  function handleApplyPreset(mode: ProjectCreateMode) {
    applyPreset(mode);
    setRootfsMode("catalog");
    setRootfsSearch("");
  }

  function renderRootfsHelp(): React.JSX.Element {
    return (
      <Space orientation="vertical" size="small" style={{ maxWidth: 420 }}>
        <Paragraph style={{ marginBottom: 0 }}>
          An image defines the software installed in the project.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Choose SageMath for Sage/Python/math work, R for R projects, and
          minimal images only when you want a small base to customize yourself.
          GPU images provide CUDA-ready software, but GPU hardware also requires
          a GPU project host.
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
        <RootfsCatalogPicker
          images={pickerRootfsImages}
          selectedImage={draft.rootfs_image}
          selectedId={draft.rootfs_image_id}
          onSelect={(entry) =>
            setRootfs({ image: entry.image, image_id: entry.id })
          }
          loading={rootfsLoading}
          disabled={saving}
          search={rootfsSearch}
          onSearchChange={setRootfsSearch}
        />
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
          title="Advanced OCI / Docker image"
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
        style={{ borderColor: UI_COLORS.border }}
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
                  background: UI_COLORS.warningBg,
                  borderRadius: 10,
                  color: UI_COLORS.warning,
                  display: "inline-flex",
                  height: 32,
                  justifyContent: "center",
                  width: 32,
                }}
              >
                <Icon name="cube" />
              </span>
              <span>
                <div style={{ fontWeight: 700, color: UI_COLORS.text }}>
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
                    onClick={() => handleApplyPreset(preset.mode)}
                    style={{
                      borderColor: active ? UI_COLORS.focus : UI_COLORS.border,
                      background: active
                        ? UI_COLORS.selected
                        : UI_COLORS.surface,
                      color: active ? UI_COLORS.link : UI_COLORS.text,
                      boxShadow: active
                        ? `0 0 0 1px ${UI_COLORS.focus} inset`
                        : undefined,
                    }}
                  >
                    {preset.title}
                  </button>
                );
              })}
            </Space>
          </Space>
          <Typography.Text
            className="cc-project-create-preset-description"
            type="secondary"
            style={{ fontSize: 12 }}
          >
            {projectPresetDescription(
              PROJECT_PRESETS.find((preset) => preset.mode === draft.mode) ??
                PROJECT_PRESETS[0],
            )}
          </Typography.Text>
          {!selectedRootfsEntry && displayImage && (
            <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              {displayImage}
            </code>
          )}
          {selectedRootfsEntry && renderRootfsWarning(selectedRootfsEntry)}
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
      "Project name required";
    const summaryItems = [
      {
        icon: "project-outlined",
        label: "Project name",
        value: title,
        color: UI_COLORS.infoBg,
      },
      {
        icon: "sliders",
        label: "Preset",
        value: presetTitle(draft.mode),
        color: UI_COLORS.inset,
        hidden: !runtime.rootfs,
      },
      {
        icon: "cube",
        label: "Image",
        value: summary.rootfsLabel,
        color: UI_COLORS.warningBg,
        hidden: !runtime.rootfs,
      },
      {
        icon: "servers",
        label: "Host / region",
        value: summary.hostName || summary.host_id || "Automatic placement",
        color: UI_COLORS.successBg,
        hidden: IS_STAR_SETUP_PROFILE || !runtime.host_placement,
      },
      {
        icon: "database",
        label: "Backups",
        value: R2_REGION_LABELS[draft.region],
        color: UI_COLORS.inset,
        hidden: !runtime.backups,
      },
      {
        icon: "terminal",
        label: "Runtime",
        value: runtime.label,
        color: UI_COLORS.infoBg,
      },
    ];
    return (
      <Card
        size="small"
        styles={{ body: { padding: 16 } }}
        className="cc-project-create-summary-card"
        style={{
          borderColor: UI_COLORS.border,
          background: UI_COLORS.surface,
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
                        : `1px solid ${UI_COLORS.border}`,
                  }}
                >
                  <span
                    className="cc-project-create-summary-icon"
                    style={{
                      background: item.color,
                      color: UI_COLORS.info,
                    }}
                  >
                    <Icon name={item.icon as any} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
                      {item.label}
                    </div>
                    <div
                      style={{
                        color: UI_COLORS.text,
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
            {runtime.gpu && summary.gpu && <Tag color="purple">GPU</Tag>}
            {runtime.rootfs && selectedRootfsEntry?.section && (
              <Tag color={sectionTagColor(selectedRootfsEntry.section)}>
                {sectionLabel(selectedRootfsEntry.section)}
              </Tag>
            )}
            {runtime.rootfs && selectedRootfsEntry?.warning && (
              <Tag color="orange">Review</Tag>
            )}
            {runtime.rootfs && !selectedRootfsEntry && summary.rootfs_image && (
              <Tag color={isAdmin ? "orange" : "red"}>
                {isAdmin ? "Advanced OCI" : "Unavailable image"}
              </Tag>
            )}
          </Space>
          {runtime.rootfs && summary.warnings.length > 0 && (
            <Alert type="warning" showIcon title={summary.warnings.join(" ")} />
          )}
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Button
              type="primary"
              block
              onClick={() => create_project({ openAfterCreate: true })}
              disabled={isDisabled()}
              title={
                titleIsMissing
                  ? "Enter a project name before creating."
                  : undefined
              }
              loading={createAction === "open"}
              icon={<Icon name="arrow-right" />}
            >
              Create and Open
            </Button>
            <Button
              block
              onClick={() => create_project({ openAfterCreate: false })}
              disabled={isDisabled()}
              title={
                titleIsMissing
                  ? "Enter a project name before creating."
                  : undefined
              }
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
                whitespace: true,
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
              onChange={(e) => {
                setTitle(e.target.value);
                setTitlePreview(e.target.value);
              }}
              autoFocus
            />
          </Form.Item>
        </Form>
        {runtime.trusted && (
          <Alert
            type="warning"
            showIcon
            title="Trusted workspace runtime"
            description="This project runs directly on the Launchpad workspace host without container isolation. Host, image, GPU, backup, snapshot, SSH, and resource-limit controls are unavailable."
          />
        )}
        {runtime.rootfs && renderRootfsSection()}
        {!IS_STAR_SETUP_PROFILE && runtime.host_placement && (
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
              background: UI_COLORS.infoBg,
              color: UI_COLORS.info,
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
      mask={{ closable: !saving }}
      styles={{
        body: {
          background: UI_COLORS.inset,
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
