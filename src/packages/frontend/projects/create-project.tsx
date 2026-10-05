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
  Checkbox,
  Form,
  Input,
  Modal,
  Popover,
  Space,
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
import { SelectNewHost } from "@cocalc/frontend/hosts/select-new-host";
import { latestRootfsVersionEntries } from "@cocalc/frontend/rootfs/catalog-ui";
import { RootfsCatalogPicker } from "@cocalc/frontend/rootfs/catalog-picker";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import {
  describeProjectImageReason,
  isNewProjectRootfsSelectable,
} from "./create-project-rootfs";
import {
  type ProjectCreateMode,
  projectDraftToCreateOptions,
  rootfsEntryMatchesProjectMode,
} from "./create/project-create-draft";
import { ProjectCreateHealthCard } from "./create/project-create-health-card";
import { useProjectCreateDraft } from "./create/use-project-create-draft";
import { useProjectRuntimeCapabilities } from "@cocalc/frontend/project/runtime-capabilities";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import "./create-project.css";

const IS_STAR_SETUP_PROFILE = cocalc_setup_profile === "star";

interface Props {
  default_value: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (projectId: string) => void;
}

export function NewProjectCreator({
  default_value,
  open,
  onClose,
  onCreated,
}: Props) {
  const runtime = useProjectRuntimeCapabilities();
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();

  const [error, set_error] = useState<string>("");
  const [createAction, setCreateAction] = useState<"create" | "open" | null>(
    null,
  );
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
      // Official images first; otherwise the catalog's order.
      latestRootfsVersionEntries(filteredRootfsImages, {
        showOlderVersions: showOlderRootfsVersions,
        preserveIds: [draft.rootfs_image_id],
      })
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            Number(!!b.entry.official) - Number(!!a.entry.official) ||
            a.index - b.index,
        )
        .map(({ entry }) => entry),
    [draft.rootfs_image_id, filteredRootfsImages, showOlderRootfsVersions],
  );
  // GPU is offered only when a GPU host is available to you (yours, or one
  // shared with you).
  const [gpuHostAvailable, setGpuHostAvailable] = useState(false);
  useEffect(() => {
    if (!open || !runtime.gpu) return;
    let canceled = false;
    void webapp_client.conat_client.hub.hosts
      .listHosts({ catalog: true })
      .then((hosts) => {
        if (!canceled) {
          setGpuHostAvailable(
            (hosts ?? []).some(
              (host: any) => host?.gpu === true && !host?.deleted,
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [open, runtime.gpu]);
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

    if (onCreated) {
      onCreated(project_id);
    } else if (openAfterCreate) {
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
      create_project({ openAfterCreate: !onCreated });
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
          An image is the software installed in the project: choose SageMath for
          Sage and math, R for R, and so on. You can change it later.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Search finds images by name, purpose or tag (e.g. teaching).
        </Paragraph>
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

  // One section: what is chosen and why, then the list to change it.
  function renderRootfsSection(): React.JSX.Element {
    const displayImage = draft.rootfs_image?.trim() || "";
    const reason = describeProjectImageReason(draft.rootfs_reason);
    return (
      <section aria-label="Image">
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          <span style={{ fontWeight: 600 }}>Image</span>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {selectedRootfsEntry?.label || displayImage || "Choose one below"}
            {reason ? ` (${reason})` : ""}
          </Typography.Text>
          <span style={{ flex: 1 }} />
          <Popover content={renderRootfsHelp()} trigger="click">
            <Button size="small" type="link" style={{ padding: 0 }}>
              What should I choose?
            </Button>
          </Popover>
        </div>
        {!selectedRootfsEntry && displayImage && (
          <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
            {displayImage}
          </code>
        )}
        {selectedRootfsEntry && renderRootfsWarning(selectedRootfsEntry)}
        {rootfsMode === "catalog" ? (
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
              searchPlaceholder="Search images, e.g. SageMath, R, Python, LaTeX, teaching..."
              height="auto"
              maxHeight={300}
            />
            <Space wrap size="middle">
              {(gpuHostAvailable || draft.mode === "gpu") && (
                <Checkbox
                  checked={draft.mode === "gpu"}
                  onChange={(e) =>
                    handleApplyPreset(e.target.checked ? "gpu" : "standard")
                  }
                  disabled={saving}
                >
                  Use a GPU
                </Checkbox>
              )}
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
                  style={{ padding: 0 }}
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
        ) : (
          renderCustomRootfsSelector()
        )}
      </section>
    );
  }

  // Asked for in place (name, image); only other problems are warnings.
  const otherWarnings = summary.warnings.filter(
    (warning) =>
      warning !== "Project title is required." &&
      warning !== "Choose an image.",
  );

  useEffect(() => {
    if (open) {
      start_editing();
    } else {
      reset_form();
    }
  }, [open]);

  if (!open) return null;

  const createDisabledTitle = titleIsMissing
    ? "Name the project first."
    : runtime.rootfs && !summary.rootfs_image.trim()
      ? "Choose an image first."
      : undefined;

  return (
    <Modal
      open={open}
      destroyOnHidden
      className="cc-project-create-modal"
      width="min(720px, 96vw)"
      title={intl.formatMessage(labels.create_project)}
      onCancel={cancel_editing}
      mask={{ closable: !saving }}
      styles={{
        body: { maxHeight: "min(720px, 80vh)", overflowY: "auto" },
      }}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={cancel_editing} disabled={saving}>
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button
            type={onCreated ? "primary" : "default"}
            onClick={() => create_project({ openAfterCreate: false })}
            disabled={isDisabled()}
            title={createDisabledTitle}
            loading={createAction === "create"}
          >
            Create
          </Button>
          {!onCreated && (
            <Button
              type="primary"
              onClick={() => create_project({ openAfterCreate: true })}
              disabled={isDisabled()}
              title={createDisabledTitle}
              loading={createAction === "open"}
              icon={<Icon name="arrow-right" />}
            >
              Create and open
            </Button>
          )}
        </div>
      }
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Form form={form} layout="vertical">
          <Form.Item
            label={<span style={{ fontWeight: 600 }}>Name</span>}
            name="title"
            style={{ marginBottom: 0 }}
            initialValue={draft.title}
          >
            <Input
              ref={new_project_title_ref}
              size="large"
              placeholder={`Name your new ${projectLabelLower}`}
              disabled={saving}
              onKeyDown={handle_keypress}
              onChange={(e) => {
                setTitle(e.target.value);
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
        <ProjectCreateHealthCard open={open} onlyWhenNeeded />
        {runtime.rootfs && otherWarnings.length > 0 && (
          <Alert type="warning" showIcon title={otherWarnings.join(" ")} />
        )}
        {render_error()}
      </Space>
    </Modal>
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
