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
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { A, ErrorDisplay, Icon, Paragraph } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import track from "@cocalc/frontend/user-tracking";
import {
  DEFAULT_R2_REGION,
  mapCountryRegionToR2Region,
  mapCloudRegionToR2Region,
  R2_REGION_LABELS,
  R2_REGIONS,
  type R2Region,
} from "@cocalc/util/consts";
import { capitalize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

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

  const [title_text, set_title_text] = useState<string>(
    default_value ?? getDefaultTitle(),
  );
  const [error, set_error] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const new_project_title_ref = useRef<any>(null);
  const [selectedHost, setSelectedHost] = useState<Host | undefined>();
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const preferredProjectRegion = useMemo(
    () =>
      mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode) ??
      DEFAULT_R2_REGION,
    [cloudflareCountry, cloudflareRegionCode],
  );
  const [projectRegion, setProjectRegion] = useState<R2Region>(
    preferredProjectRegion,
  );
  const [rootfsModalOpen, setRootfsModalOpen] = useState<boolean>(false);
  const [rootfsTouched, setRootfsTouched] = useState<boolean>(false);
  const [rootfsImage, setRootfsImage] = useState<string | undefined>();
  const [rootfsImageId, setRootfsImageId] = useState<string | undefined>();
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsDraftId, setRootfsDraftId] = useState<string | undefined>();
  const regionOptions = useMemo(
    () =>
      R2_REGIONS.map((region) => ({
        value: region,
        label: R2_REGION_LABELS[region],
      })),
    [],
  );
  const siteDefaultRootfs = useTypedRedux(
    "customize",
    "project_rootfs_default_image",
  );
  const siteDefaultRootfsGpu = useTypedRedux(
    "customize",
    "project_rootfs_default_image_gpu",
  );
  const accountDefaultRootfs = useTypedRedux("account", "default_rootfs_image");
  const accountDefaultRootfsGpu = useTypedRedux(
    "account",
    "default_rootfs_image_gpu",
  );

  const [form] = Form.useForm();
  const {
    images: rootfsImages,
    loading: rootfsLoading,
    error: rootfsError,
  } = useRootfsImages([managedRootfsCatalogUrl()]);
  const isGpu = selectedHost?.gpu ?? false;
  const effectiveDefaultRootfs = useMemo(() => {
    const siteDefault = siteDefaultRootfs?.trim() || DEFAULT_PROJECT_IMAGE;
    const siteGpu = siteDefaultRootfsGpu?.trim() || "";
    const accountDefault = accountDefaultRootfs?.trim() || "";
    const accountDefaultGpu = accountDefaultRootfsGpu?.trim() || "";
    if (isGpu) {
      return (
        accountDefaultGpu ||
        siteGpu ||
        accountDefault ||
        siteDefault ||
        DEFAULT_PROJECT_IMAGE
      );
    }
    return accountDefault || siteDefault || DEFAULT_PROJECT_IMAGE;
  }, [
    accountDefaultRootfs,
    accountDefaultRootfsGpu,
    isGpu,
    siteDefaultRootfs,
    siteDefaultRootfsGpu,
  ]);
  const filteredRootfsImages = useMemo(
    () =>
      rootfsImages.filter((entry) => {
        if (isGpu) return true;
        return entry.gpu !== true;
      }),
    [rootfsImages, isGpu],
  );
  const selectedRootfsEntry = useMemo(() => {
    const imageId = rootfsImageId?.trim();
    if (imageId) {
      return rootfsImages.find((entry) => entry.id === imageId);
    }
    const image = rootfsImage?.trim();
    if (!image) return undefined;
    return rootfsImages.find((entry) => entry.image === image);
  }, [rootfsImage, rootfsImageId, rootfsImages]);
  const rootfsGroupedOptions = useMemo(
    () => groupedRootfsOptions(filteredRootfsImages),
    [filteredRootfsImages],
  );

  useEffect(() => {
    form.setFieldsValue({ title: title_text });
  }, [title_text]);

  useEffect(() => {
    if (!selectedHost) return;
    const hostRegion = mapCloudRegionToR2Region(selectedHost.region);
    if (hostRegion !== projectRegion) {
      setSelectedHost(undefined);
    }
  }, [projectRegion, selectedHost]);

  useEffect(() => {
    if (!rootfsTouched) {
      setRootfsImage(effectiveDefaultRootfs);
      setRootfsImageId(
        rootfsImages.find((entry) => entry.image === effectiveDefaultRootfs)
          ?.id,
      );
    }
  }, [effectiveDefaultRootfs, rootfsImages, rootfsTouched]);

  const is_mounted_ref = useIsMountedRef();

  async function select_text(): Promise<void> {
    // wait for next render loop so the title actually is in the DOM...
    await delay(1);
    (new_project_title_ref.current as any)?.input?.select();
  }

  function getDefaultTitle(): string {
    const ts = new Date().toISOString().split("T")[0];
    return `Untitled ${ts}`;
  }

  function reset_form(): void {
    set_title_text(default_value || getDefaultTitle());
    setProjectRegion(preferredProjectRegion);
    setSelectedHost(undefined);
    setShowAdvanced(false);
    set_error("");
    setSaving(false);
    setRootfsTouched(false);
    setRootfsImage(effectiveDefaultRootfs);
    setRootfsImageId(undefined);
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
    const chosenRootfs =
      rootfsImage?.trim() || effectiveDefaultRootfs || DEFAULT_PROJECT_IMAGE;
    const opts = {
      title: title_text,
      rootfs_image: chosenRootfs,
      rootfs_image_id: rootfsImageId?.trim() || undefined,
      start: true,
      host_id: selectedHost?.id,
      region: projectRegion,
    };
    try {
      project_id = await actions.create_project(opts);
    } catch (err) {
      if (!is_mounted_ref.current) return;
      setSaving(false);
      setShowAdvanced(true);
      set_error(`Error creating ${projectLabelLower} -- ${err}`);
      return;
    }
    track("create-project", {
      how: "projects-page",
      project_id,
      ...opts,
    });
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
      !title_text?.trim() ||
      // currently saving (?)
      saving
    );
  }

  function input_on_change(): void {
    const text = (new_project_title_ref.current as any)?.input?.value;
    set_title_text(text);
  }

  function handle_keypress(e): void {
    if (e.keyCode === 27) {
      cancel_editing();
    } else if (e.keyCode === 13 && title_text !== "") {
      create_project();
    }
  }

  function openRootfsModal() {
    const current = (rootfsImage?.trim() ||
      effectiveDefaultRootfs ||
      DEFAULT_PROJECT_IMAGE) as string;
    setRootfsDraft(current);
    const currentEntry =
      filteredRootfsImages.find((entry) => entry.id === rootfsImageId) ??
      filteredRootfsImages.find((entry) => entry.image === current);
    setRootfsDraftId(currentEntry?.id);
    const isCatalog = !!currentEntry;
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
            setRootfsImage(trimmed || effectiveDefaultRootfs);
            setRootfsImageId(undefined);
          } else {
            const nextEntry =
              filteredRootfsImages.find(
                (entry) => entry.id === rootfsDraftId,
              ) ??
              filteredRootfsImages.find((entry) => entry.image === rootfsDraft);
            setRootfsImage(nextEntry?.image || effectiveDefaultRootfs);
            setRootfsImageId(nextEntry?.id);
          }
          setRootfsTouched(true);
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
              <Button
                type="link"
                onClick={() => setRootfsMode("custom")}
                style={{ paddingLeft: 0, width: "fit-content" }}
              >
                Use an advanced OCI or Docker image instead
              </Button>
              {activeEntry?.description && (
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {activeEntry.description}
                </Paragraph>
              )}
              {activeEntry && renderRootfsWarning(activeEntry)}
              {activeEntry && renderRootfsScan(activeEntry)}
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
                message="Advanced OCI / Docker image"
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
    const displayImage =
      rootfsImage?.trim() || effectiveDefaultRootfs || DEFAULT_PROJECT_IMAGE;
    const displayLabel =
      selectedRootfsEntry?.label || displayImage || DEFAULT_PROJECT_IMAGE;
    return (
      <Card size="small" bodyStyle={{ padding: "10px 12px" }}>
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
          {selectedRootfsEntry && renderRootfsScan(selectedRootfsEntry)}
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
            initialValue={title_text}
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
          onClick={() => setShowAdvanced((prev) => !prev)}
          style={{ paddingLeft: 0 }}
        >
          {showAdvanced ? "Hide advanced" : "Show advanced"}
        </Button>
        {showAdvanced && (
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
            <Card size="small" bodyStyle={{ padding: "10px 12px" }}>
              <Space
                orientation="vertical"
                size="small"
                style={{ width: "100%" }}
              >
                <div style={{ fontWeight: 600 }}>Backup region</div>
                <Select
                  value={projectRegion}
                  onChange={(value) => setProjectRegion(value as R2Region)}
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
              onChange={setSelectedHost}
              regionFilter={projectRegion}
              regionLabel={R2_REGION_LABELS[projectRegion]}
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

function sectionLabel(section: RootfsImageEntry["section"]): string {
  switch (section) {
    case "official":
      return "Official";
    case "mine":
      return "My image";
    case "collaborators":
      return "Collaborator image";
    case "public":
      return "Public image";
    default:
      return "Catalog";
  }
}

function sectionTagColor(section: RootfsImageEntry["section"]): string {
  switch (section) {
    case "official":
      return "blue";
    case "mine":
      return "green";
    case "collaborators":
      return "gold";
    case "public":
      return "red";
    default:
      return "default";
  }
}

function groupedRootfsOptions(images: RootfsImageEntry[]) {
  const sections: Array<{
    key: NonNullable<RootfsImageEntry["section"]>;
    label: string;
  }> = [
    { key: "official", label: "Official images" },
    { key: "mine", label: "My images" },
    { key: "collaborators", label: "Collaborator images" },
    { key: "public", label: "Public images" },
  ];
  return sections.reduce<
    Array<{
      label: string;
      options: Array<{
        value: string;
        label: string;
        searchText: string;
        entry: RootfsImageEntry;
      }>;
    }>
  >((acc, { key, label }) => {
    const options = images
      .filter((entry) => entry.section === key)
      .map((entry) => ({
        value: entry.id,
        label: entry.label || entry.image,
        entry,
        searchText: [
          entry.label,
          entry.image,
          entry.description,
          entry.owner_name,
          ...(entry.tags ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      }));
    if (options.length > 0) {
      acc.push({ label, options });
    }
    return acc;
  }, []);
}

function rootfsOptionSearchText(option?: any): string {
  return `${option?.searchText ?? option?.data?.searchText ?? ""}`.toLowerCase();
}

function renderRootfsCatalogOption(entry: RootfsImageEntry) {
  return (
    <div
      style={{
        padding: "6px 0",
        lineHeight: "18px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
          marginBottom: "2px",
        }}
      >
        <span style={{ fontWeight: 600 }}>{entry.label || entry.image}</span>
        {entry.section ? (
          <Tag
            color={sectionTagColor(entry.section)}
            style={{ marginInlineEnd: 0 }}
          >
            {sectionLabel(entry.section)}
          </Tag>
        ) : null}
        {entry.version ? (
          <Tag style={{ marginInlineEnd: 0 }}>{entry.version}</Tag>
        ) : null}
        {entry.channel ? (
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            {entry.channel}
          </Tag>
        ) : null}
        {entry.gpu ? (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            GPU
          </Tag>
        ) : null}
        {entry.scan?.status && entry.scan.status !== "unknown" ? (
          <Tag
            color={
              entry.scan.status === "clean"
                ? "green"
                : entry.scan.status === "findings"
                  ? "orange"
                  : entry.scan.status === "error"
                    ? "red"
                    : "blue"
            }
            style={{ marginInlineEnd: 0 }}
          >
            scan {entry.scan.status}
          </Tag>
        ) : null}
      </div>
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "11px",
          color: COLORS.GRAY_M,
          overflowWrap: "anywhere",
          marginBottom: entry.description ? "2px" : 0,
        }}
      >
        {entry.image}
      </div>
      {entry.description ? (
        <div
          style={{
            fontSize: "12px",
            color: COLORS.GRAY_D,
            overflowWrap: "anywhere",
          }}
        >
          {entry.description}
        </div>
      ) : null}
    </div>
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

function renderRootfsScan(
  entry: RootfsImageEntry,
): React.JSX.Element | undefined {
  const scan = entry.scan;
  if (!scan?.status || scan.status === "unknown") {
    return;
  }
  const color =
    scan.status === "clean"
      ? "green"
      : scan.status === "findings"
        ? "orange"
        : scan.status === "error"
          ? "red"
          : "blue";
  return (
    <Paragraph type="secondary" style={{ marginBottom: 0 }}>
      <Tag color={color}>Scan: {scan.status}</Tag>
      {scan.tool ? ` ${scan.tool}` : ""}
      {scan.summary ? ` - ${scan.summary}` : ""}
    </Paragraph>
  );
}
