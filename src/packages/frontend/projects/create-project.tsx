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
  icon: string;
}[] = [
  {
    mode: "standard",
    title: "Standard",
    description: "Default or catalog-tagged base image, automatic host.",
    icon: "project-outlined",
  },
  {
    mode: "gpu",
    title: "GPU",
    description: "GPU-tagged image when one is available.",
    icon: "bolt",
  },
  {
    mode: "teaching",
    title: "Teaching",
    description: "Teaching-tagged image for classes and workshops.",
    icon: "graduation-cap",
  },
  {
    mode: "custom",
    title: "Custom",
    description: "Choose your own runtime image and host.",
    icon: "sliders",
  },
];

function projectPresetDescription(preset: (typeof PROJECT_PRESETS)[number]) {
  if (!IS_STAR_SETUP_PROFILE) return preset.description;
  switch (preset.mode) {
    case "standard":
      return "Default or catalog-tagged base image.";
    case "custom":
      return "Choose your own runtime image.";
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
  const [rootfsPickerOpen, setRootfsPickerOpen] = useState<boolean>(false);
  const [showOlderRootfsVersions, setShowOlderRootfsVersions] =
    useState<boolean>(false);
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsDraftId, setRootfsDraftId] = useState<string | undefined>();
  const [rootfsSearch, setRootfsSearch] = useState("");
  const [hostPickerOpen, setHostPickerOpen] = useState<boolean>(false);
  const {
    draft,
    summary,
    rootfsImages,
    rootfsLoading,
    rootfsError,
    context,
    isAdmin,
    selectedHost,
    setHost,
    setRootfs,
    applyPreset,
    reset,
  } = useProjectCreateDraft({
    defaultValue: default_value,
    rootfsQuery: rootfsSearch,
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
      return filteredRootfsImages.find((entry) => entry.id === imageId);
    }
    const image = draft.rootfs_image?.trim();
    if (!image) return undefined;
    return filteredRootfsImages.find((entry) => entry.image === image);
  }, [draft.rootfs_image, draft.rootfs_image_id, filteredRootfsImages]);
  const rootfsGroupedOptions = useMemo(
    () => groupedRootfsOptions(pickerRootfsImages),
    [pickerRootfsImages],
  );

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
    setRootfsPickerOpen(false);
    setHostPickerOpen(false);
    setRootfsMode("catalog");
    setRootfsDraft("");
    setRootfsDraftId(undefined);
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

  function openRootfsPicker() {
    const current = (draft.rootfs_image?.trim() ||
      (isAdmin ? DEFAULT_PROJECT_IMAGE : "")) as string;
    setRootfsDraft(current);
    const currentEntry =
      filteredRootfsImages.find(
        (entry) => entry.id === draft.rootfs_image_id,
      ) ?? filteredRootfsImages.find((entry) => entry.image === current);
    setRootfsDraftId(currentEntry?.id);
    const isCatalog = !!currentEntry || !isAdmin;
    setRootfsMode(isCatalog ? "catalog" : "custom");
    setRootfsPickerOpen(true);
  }

  function applyRootfsDraft() {
    const trimmed = rootfsDraft.trim();
    if (rootfsMode === "custom") {
      if (!isAdmin) {
        set_error("Only admins can use advanced OCI images.");
        return;
      }
      setRootfs({ image: trimmed || DEFAULT_PROJECT_IMAGE });
    } else {
      const nextEntry =
        filteredRootfsImages.find((entry) => entry.id === rootfsDraftId) ??
        filteredRootfsImages.find((entry) => entry.image === rootfsDraft);
      setRootfs({
        image: nextEntry?.image || draft.rootfs_image,
        image_id: nextEntry?.id,
      });
    }
    setRootfsPickerOpen(false);
  }

  function renderRootfsPicker() {
    if (!rootfsPickerOpen) return null;
    const activeEntry =
      filteredRootfsImages.find((entry) => entry.id === rootfsDraftId) ??
      filteredRootfsImages.find((entry) => entry.image === rootfsDraft);
    return (
      <Card
        size="small"
        styles={{ body: { padding: "10px 12px" } }}
        style={{
          borderColor: COLORS.GRAY_LL,
          background: "white",
        }}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Pick a managed RootFS image for this project. Scan findings are
            shown for review but do not block selection.
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
                onSearch={(value) => setRootfsSearch(value)}
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
              <Space wrap>
                <Button
                  type="primary"
                  onClick={applyRootfsDraft}
                  disabled={!rootfsDraftId}
                >
                  Use this image
                </Button>
                <Button onClick={() => setRootfsPickerOpen(false)}>
                  Cancel
                </Button>
              </Space>
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
              {activeEntry && (
                <RootfsScanSummaryButton
                  entry={activeEntry}
                  title={`RootFS scan details: ${activeEntry.label}`}
                />
              )}
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
              <Space wrap>
                <Button
                  type="primary"
                  onClick={applyRootfsDraft}
                  disabled={!rootfsDraft.trim()}
                >
                  Use this image
                </Button>
                <Button onClick={() => setRootfsPickerOpen(false)}>
                  Cancel
                </Button>
              </Space>
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
      </Card>
    );
  }

  function renderRootfsSection(): React.JSX.Element {
    const displayImage =
      draft.rootfs_image?.trim() || (isAdmin ? DEFAULT_PROJECT_IMAGE : "");
    const displayLabel =
      selectedRootfsEntry?.label || displayImage || "No RootFS image selected";
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
                  {displayLabel}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Runtime image
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
            <Button size="small" onClick={openRootfsPicker} disabled={saving}>
              {rootfsPickerOpen ? "Change image..." : "Choose image..."}
            </Button>
          </Space>
          {!selectedRootfsEntry && displayImage && (
            <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              {displayImage}
            </code>
          )}
          {selectedRootfsEntry && renderRootfsWarning(selectedRootfsEntry)}
          {renderRootfsPicker()}
        </Space>
      </Card>
    );
  }

  function renderPresetSection(): React.JSX.Element {
    return (
      <div className="cc-project-create-preset-grid">
        {PROJECT_PRESETS.map((preset) => {
          const active = draft.mode === preset.mode;
          return (
            <Button
              key={preset.mode}
              onClick={() => applyPreset(preset.mode)}
              disabled={saving}
              style={{
                borderColor: active ? COLORS.BS_BLUE_BGRND : COLORS.GRAY_LL,
                background: active ? COLORS.ANTD_BG_BLUE_L : "white",
                boxShadow: active
                  ? `0 0 0 1px ${COLORS.BS_BLUE_BGRND} inset`
                  : undefined,
              }}
              className="cc-project-create-preset-button"
            >
              <Space orientation="vertical" align="center" size={6}>
                <span
                  className="cc-project-create-preset-icon"
                  style={{
                    background: active ? "white" : COLORS.GRAY_LLL,
                    color: active ? COLORS.BS_BLUE_TEXT : COLORS.GRAY_M,
                  }}
                >
                  <Icon name={preset.icon as any} />
                </span>
                <span>
                  <div style={{ fontWeight: 600, color: COLORS.GRAY_D }}>
                    {preset.title}
                  </div>
                  <div
                    className="cc-project-create-preset-description"
                    style={{
                      color: COLORS.GRAY_M,
                    }}
                  >
                    {projectPresetDescription(preset)}
                  </div>
                </span>
              </Space>
            </Button>
          );
        })}
      </div>
    );
  }

  function renderRegionFact(label: string, value: React.ReactNode) {
    return (
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
        <div style={{ fontWeight: 600 }}>{value}</div>
      </div>
    );
  }

  function renderRegionExplanation(): React.JSX.Element {
    const selectedRegionLabel = R2_REGION_LABELS[draft.region];
    const nearbyRegionLabel = R2_REGION_LABELS[context.preferredRegion];
    const providerRegion = selectedHost?.region?.trim();
    const remoteFromBrowser = context.preferredRegion !== draft.region;

    return (
      <Card
        size="small"
        styles={{ body: { padding: "10px 12px" } }}
        style={{ borderColor: COLORS.GRAY_LL, background: "white" }}
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Paragraph style={{ marginBottom: 0 }}>
            <Icon name="map" /> Host and region mainly affect interactive lag,
            such as terminal typing and Jupyter notebook output, not your data.
          </Paragraph>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
            }}
          >
            {renderRegionFact("Near you", nearbyRegionLabel)}
            {renderRegionFact("Project backups", selectedRegionLabel)}
            {renderRegionFact(
              "Provider region",
              providerRegion ? <code>{providerRegion}</code> : "Automatic",
            )}
          </div>
          {remoteFromBrowser && (
            <Alert
              type="info"
              showIcon
              message={`This is not your nearest detected region (${nearbyRegionLabel}). It may still be the best choice when the available hosts there are faster or less busy.`}
            />
          )}
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            You can change the host or region later. Cross-region moves carry
            the current files, but older backup history is not fully carried
            over.
          </Paragraph>
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
        label: "Runtime image",
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
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Choose a preset
          </div>
          {renderPresetSection()}
        </div>
        {renderRootfsSection()}
        {!IS_STAR_SETUP_PROFILE && (
          <>
            <SelectNewHost
              disabled={saving}
              selectedHost={selectedHost}
              onChange={setHost}
              regionFilter={draft.region}
              regionLabel={R2_REGION_LABELS[draft.region]}
              wantsGpu={summary.gpu}
              pickerMode="create"
              pickerDisplay="inline"
              pickerOpen={hostPickerOpen}
              onPickerOpenChange={setHostPickerOpen}
              showHelp={false}
            />
            {hostPickerOpen && renderRegionExplanation()}
          </>
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
