/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { dirname, join } from "path";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Paragraph } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import RootfsPublishOps from "@cocalc/frontend/project/settings/rootfs-publish-ops";
import {
  managedRootfsCatalogUrl,
  publishProjectRootfsImage,
  saveRootfsCatalogEntry,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  DEFAULT_PROJECT_IMAGE,
  PROJECT_IMAGE_PATH,
} from "@cocalc/util/db-schema/defaults";
import { split } from "@cocalc/util/misc";
import type {
  RootfsImageEntry,
  RootfsImageVisibility,
} from "@cocalc/util/rootfs-images";

type PublishDraft = {
  image: string;
  label: string;
  description: string;
  visibility: RootfsImageVisibility;
  tags: string;
  official: boolean;
  prepull: boolean;
  hidden: boolean;
};

export default function RootFilesystemImage() {
  const { actions, project, project_id } = useProjectContext();
  const [open, setOpen] = useState<boolean>(false);
  const [publishOpen, setPublishOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [help, setHelp] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [imageId, setImageId] = useState<string>("");
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsDraftId, setRootfsDraftId] = useState<string>("");
  const [images, setImages] = useState<string[]>([DEFAULT_PROJECT_IMAGE]);
  const [catalogRefresh, setCatalogRefresh] = useState<number>(0);
  const [publishMode, setPublishMode] = useState<"copy" | "manage">("copy");
  const [publishCopyMode, setPublishCopyMode] = useState<"project" | "base">(
    "project",
  );
  const [publishSourceEntry, setPublishSourceEntry] =
    useState<RootfsImageEntry>();
  const [publishDraft, setPublishDraft] = useState<PublishDraft>({
    image: DEFAULT_PROJECT_IMAGE,
    label: "",
    description: "",
    visibility: "private",
    tags: "",
    official: false,
    prepull: false,
    hidden: false,
  });

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
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const rootfsPublishOps = useTypedRedux({ project_id }, "rootfs_publish_ops");
  const seenCompletedPublishOpsRef = useRef<Set<string>>(new Set());

  const effectiveDefaultRootfs = useMemo(() => {
    const siteDefault = siteDefaultRootfs?.trim() || DEFAULT_PROJECT_IMAGE;
    const siteGpu = siteDefaultRootfsGpu?.trim() || "";
    const accountDefault = accountDefaultRootfs?.trim() || "";
    const accountDefaultGpu = accountDefaultRootfsGpu?.trim() || "";
    return (
      accountDefaultGpu ||
      siteGpu ||
      accountDefault ||
      siteDefault ||
      DEFAULT_PROJECT_IMAGE
    );
  }, [
    accountDefaultRootfs,
    accountDefaultRootfsGpu,
    siteDefaultRootfs,
    siteDefaultRootfsGpu,
  ]);

  const {
    images: rootfsImages,
    loading: rootfsLoading,
    error: rootfsError,
  } = useRootfsImages([managedRootfsCatalogUrl(catalogRefresh)]);

  const selectedRootfsEntry = useMemo(() => {
    const selectedId = imageId.trim();
    if (selectedId) {
      return rootfsImages.find((entry) => entry.id === selectedId);
    }
    const image = value.trim();
    if (!image) return undefined;
    return rootfsImages.find((entry) => entry.image === image);
  }, [imageId, rootfsImages, value]);

  const draftRootfsEntry = useMemo(() => {
    const selectedId = rootfsDraftId.trim();
    if (selectedId) {
      return rootfsImages.find((entry) => entry.id === selectedId);
    }
    const image = rootfsDraft.trim();
    if (!image) return undefined;
    return rootfsImages.find((entry) => entry.image === image);
  }, [rootfsDraft, rootfsDraftId, rootfsImages]);

  const rootfsOptions = useMemo(
    () => groupedRootfsOptions(rootfsImages),
    [rootfsImages],
  );

  useEffect(() => {
    const nextImage = getImage(project, effectiveDefaultRootfs);
    setValue(nextImage);
    setImageId(project?.get("rootfs_image_id", "")?.trim() ?? "");
  }, [effectiveDefaultRootfs, project]);

  useEffect(() => {
    if (project == null) return;
    (async () => {
      try {
        setImages(await getImages(project.get("project_id")));
      } catch {
        // ignore recent image listing failures
      }
    })();
  }, [project?.get("project_id")]);

  useEffect(() => {
    const ops = rootfsPublishOps?.toJS() ?? {};
    for (const op of Object.values(ops) as Array<{
      op_id: string;
      summary?: any;
    }>) {
      if (op.summary?.status !== "succeeded") {
        continue;
      }
      if (seenCompletedPublishOpsRef.current.has(op.op_id)) {
        continue;
      }
      seenCompletedPublishOpsRef.current.add(op.op_id);
      setCatalogRefresh(Date.now());
    }
  }, [rootfsPublishOps]);

  if (project == null) {
    return null;
  }

  function openPicker() {
    const current = getImage(project, effectiveDefaultRootfs);
    const currentId = project?.get("rootfs_image_id", "")?.trim() ?? "";
    const currentEntry =
      rootfsImages.find((entry) => entry.id === currentId) ??
      rootfsImages.find((entry) => entry.image === current);
    setRootfsDraft(currentEntry?.image ?? current);
    setRootfsDraftId(currentEntry?.id ?? "");
    setRootfsMode(currentEntry ? "catalog" : "custom");
    setOpen(true);
  }

  function openPublishDialog() {
    const currentImage =
      rootfsMode === "custom"
        ? rootfsDraft.trim() || value || effectiveDefaultRootfs
        : draftRootfsEntry?.image || value || effectiveDefaultRootfs;
    const currentEntry =
      (rootfsMode === "catalog" ? draftRootfsEntry : undefined) ??
      selectedRootfsEntry;
    const defaultMode =
      currentEntry?.section === "mine" && currentEntry?.can_manage
        ? "manage"
        : "copy";
    setPublishSourceEntry(currentEntry);
    setPublishMode(defaultMode);
    setPublishCopyMode("project");
    setPublishDraft({
      image: currentImage,
      label:
        currentEntry?.label ||
        currentImage.split("/").slice(-1)[0] ||
        "Custom RootFS",
      description: currentEntry?.description ?? "",
      visibility: currentEntry?.visibility ?? "private",
      tags: (currentEntry?.tags ?? []).join(", "),
      official: currentEntry?.official ?? false,
      prepull: currentEntry?.prepull ?? false,
      hidden: currentEntry?.hidden ?? false,
    });
    setPublishOpen(true);
  }

  async function applyRootfsChange() {
    try {
      setSaving(true);
      if (!project) return;
      const project_id = project.get("project_id");
      const nextEntry =
        rootfsMode === "catalog"
          ? rootfsImages.find((entry) => entry.id === rootfsDraftId.trim())
          : undefined;
      const nextImage =
        rootfsMode === "custom"
          ? rootfsDraft.trim() || effectiveDefaultRootfs
          : nextEntry?.image || effectiveDefaultRootfs;
      const nextImageId =
        rootfsMode === "custom"
          ? undefined
          : nextEntry?.id?.trim() || undefined;
      const parts = split(
        nextImage.trim() ? nextImage.trim() : effectiveDefaultRootfs,
      );
      const image = parts.slice(-1)[0];
      await setRootFilesystemImage({
        project_id,
        image,
        image_id: nextImageId,
      });
      setValue(image);
      setImageId(nextImageId ?? "");
      if (project.getIn(["state", "state"]) == "running") {
        redux.getActions("projects").restart_project(project_id);
      }
      setOpen(false);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveCatalogEntry() {
    try {
      setPublishing(true);
      if (!project) {
        throw new Error("project is not available");
      }
      const tags = publishDraft.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (publishMode === "copy" && publishCopyMode === "project") {
        setOpen(false);
        setPublishOpen(false);
        const op = await publishProjectRootfsImage({
          project_id: project.get("project_id"),
          label: publishDraft.label,
          description: publishDraft.description,
          visibility: publishDraft.visibility,
          tags,
          official: isAdmin ? publishDraft.official : undefined,
          prepull: isAdmin ? publishDraft.prepull : undefined,
          hidden: isAdmin ? publishDraft.hidden : undefined,
        });
        actions?.trackRootfsPublishOp?.(op);
      } else {
        const entry = await saveRootfsCatalogEntry({
          image_id:
            publishMode === "manage" && publishSourceEntry?.can_manage
              ? publishSourceEntry.id
              : undefined,
          image: publishDraft.image,
          label: publishDraft.label,
          description: publishDraft.description,
          visibility: publishDraft.visibility,
          tags,
          official: isAdmin ? publishDraft.official : undefined,
          prepull: isAdmin ? publishDraft.prepull : undefined,
          hidden: isAdmin ? publishDraft.hidden : undefined,
        });
        setPublishOpen(false);
        setCatalogRefresh(Date.now());
        if (entry.image === value) {
          setImageId(entry.id);
        }
        if (entry.image === rootfsDraft) {
          setRootfsDraftId(entry.id);
        }
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div style={{ marginTop: "-4px", marginLeft: "-10px" }}>
      <RootfsPublishOps project_id={project_id} />
      <Button type="link" disabled={open} onClick={openPicker}>
        <code>{selectedRootfsEntry?.label || value}</code>
      </Button>
      {open && (
        <Modal
          width={760}
          open
          onCancel={() => {
            const current = getImage(project, effectiveDefaultRootfs);
            setValue(current);
            setImageId(project?.get("rootfs_image_id", "")?.trim() ?? "");
            setOpen(false);
          }}
          title={
            <>
              <Icon name="docker" style={{ marginRight: "15px" }} />
              Root Filesystem Image{" "}
              {saving && (
                <>
                  Saving...
                  <Spin />
                </>
              )}
              <Button
                size="small"
                onClick={() => setHelp(!help)}
                style={{ marginLeft: "30px" }}
              >
                Help
              </Button>
            </>
          }
          onOk={applyRootfsChange}
        >
          {help && (
            <div style={{ color: "#666", marginBottom: "8px" }}>
              <p>
                Choose a managed catalog image or enter any container image
                directly. You can change the image at any time.
              </p>
              <p>
                Changing the image changes which root filesystem lowerdir and
                upperdir are visible. If you switch back later, your previous
                changes under <code>/</code> become visible again.
              </p>
              <p>
                Catalog images can be official, published by you, published by
                collaborators, or public community images. Public images should
                be treated cautiously.
              </p>
              <p>
                The current project runtime still uses a concrete image string.
                This first slice adds managed catalog entries on top of that.
              </p>
            </div>
          )}

          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Radio.Group
              value={rootfsMode}
              onChange={(e) => setRootfsMode(e.target.value)}
            >
              <Radio value="catalog">Catalog images</Radio>
              <Radio value="custom">Custom image</Radio>
            </Radio.Group>
            {rootfsMode === "catalog" ? (
              <>
                <Select
                  showSearch
                  options={rootfsOptions}
                  value={rootfsDraftId || undefined}
                  placeholder="Select an image"
                  onChange={(nextId) => {
                    const next = rootfsImages.find(
                      (entry) => entry.id === nextId,
                    );
                    setRootfsDraft(next?.image || "");
                    setRootfsDraftId(next?.id || "");
                  }}
                  loading={rootfsLoading}
                  disabled={rootfsLoading}
                />
                {draftRootfsEntry?.description && (
                  <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {draftRootfsEntry.description}
                  </Paragraph>
                )}
                {draftRootfsEntry && renderRootfsWarning(draftRootfsEntry)}
                <Space wrap>
                  {draftRootfsEntry?.section && (
                    <Tag color={sectionTagColor(draftRootfsEntry.section)}>
                      {sectionLabel(draftRootfsEntry.section)}
                    </Tag>
                  )}
                  {draftRootfsEntry?.gpu && <Tag color="purple">GPU image</Tag>}
                  {draftRootfsEntry?.owner_name &&
                    draftRootfsEntry.section !== "mine" && (
                      <Tag>{draftRootfsEntry.owner_name}</Tag>
                    )}
                </Space>
              </>
            ) : (
              <Input
                value={rootfsDraft}
                onChange={(e) => {
                  setRootfsDraft(e.target.value);
                  setRootfsDraftId("");
                }}
                allowClear
                placeholder="e.g. ghcr.io/org/image:tag"
              />
            )}
            {rootfsError && (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Catalog load issue: {rootfsError}
              </Paragraph>
            )}

            <Space wrap>
              <Button onClick={openPublishDialog}>
                {publishActionLabel(draftRootfsEntry ?? selectedRootfsEntry)}
              </Button>
              {(rootfsDraft || value) && (
                <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
                  {(rootfsMode === "custom"
                    ? rootfsDraft
                    : draftRootfsEntry?.image || rootfsDraft || value
                  ).trim() || effectiveDefaultRootfs}
                </code>
              )}
            </Space>

            <div style={{ marginTop: "15px" }}>
              <div style={{ marginBottom: "8px" }}>Recent Images:</div>
              {images.map((image) => (
                <Tag
                  style={{
                    cursor: "pointer",
                    marginBottom: "8px",
                    padding: "6px",
                    fontSize: "11pt",
                  }}
                  color={image == value ? "#108ee9" : undefined}
                  key={image}
                  onClick={() => {
                    setRootfsDraft(image);
                    setRootfsDraftId("");
                    setRootfsMode("custom");
                  }}
                >
                  {image}
                  {image == DEFAULT_PROJECT_IMAGE ? " (default)" : ""}
                </Tag>
              ))}
            </div>
          </Space>
          <ShowError error={error} setError={setError} />
        </Modal>
      )}
      {publishOpen && (
        <Modal
          open
          width={720}
          onCancel={() => setPublishOpen(false)}
          onOk={saveCatalogEntry}
          okButtonProps={{ loading: publishing }}
          title={
            publishMode === "manage"
              ? "Manage RootFS Catalog Entry"
              : publishCopyMode === "project"
                ? "Publish Project RootFS"
                : "Save RootFS to My Images"
          }
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {publishMode === "manage"
                ? "Update catalog metadata for the currently selected RootFS entry."
                : publishCopyMode === "project"
                  ? "Create a managed RootFS image from the current project state. This uses a fresh safety snapshot and publishes the effective merged root filesystem."
                  : "Create your own catalog entry for the current base image so it appears under My images."}
            </Paragraph>
            {publishSourceEntry?.can_manage && (
              <Checkbox
                checked={publishMode === "manage"}
                onChange={(e) =>
                  setPublishMode(e.target.checked ? "manage" : "copy")
                }
              >
                {publishSourceEntry.section === "mine"
                  ? "Update the existing selected entry instead of saving another copy"
                  : "Edit the selected shared/official entry instead of saving my own copy"}
              </Checkbox>
            )}
            {publishMode !== "manage" && (
              <Radio.Group
                value={publishCopyMode}
                onChange={(e) => setPublishCopyMode(e.target.value)}
              >
                <Radio value="project">
                  Publish current project RootFS state
                </Radio>
                <Radio value="base">Save current base image only</Radio>
              </Radio.Group>
            )}
            <Input
              value={publishDraft.image}
              disabled
              addonBefore={
                publishMode === "copy" && publishCopyMode === "project"
                  ? "Base image"
                  : "Image"
              }
            />
            <Input
              value={publishDraft.label}
              onChange={(e) =>
                setPublishDraft((cur) => ({ ...cur, label: e.target.value }))
              }
              addonBefore="Label"
            />
            <Input.TextArea
              value={publishDraft.description}
              onChange={(e) =>
                setPublishDraft((cur) => ({
                  ...cur,
                  description: e.target.value,
                }))
              }
              rows={3}
              placeholder="Describe when this image should be used."
            />
            <Radio.Group
              value={publishDraft.visibility}
              onChange={(e) =>
                setPublishDraft((cur) => ({
                  ...cur,
                  visibility: e.target.value,
                }))
              }
            >
              <Radio value="private">Only me</Radio>
              <Radio value="collaborators">My collaborators</Radio>
              <Radio value="public">Public</Radio>
            </Radio.Group>
            <Input
              value={publishDraft.tags}
              onChange={(e) =>
                setPublishDraft((cur) => ({ ...cur, tags: e.target.value }))
              }
              placeholder="comma,separated,tags"
            />
            {isAdmin && (
              <Space direction="vertical" size="small">
                <Checkbox
                  checked={publishDraft.official}
                  onChange={(e) =>
                    setPublishDraft((cur) => ({
                      ...cur,
                      official: e.target.checked,
                    }))
                  }
                >
                  Official image
                </Checkbox>
                <Checkbox
                  checked={publishDraft.prepull}
                  onChange={(e) =>
                    setPublishDraft((cur) => ({
                      ...cur,
                      prepull: e.target.checked,
                    }))
                  }
                >
                  Pre-pull on new hosts
                </Checkbox>
                <Checkbox
                  checked={publishDraft.hidden}
                  onChange={(e) =>
                    setPublishDraft((cur) => ({
                      ...cur,
                      hidden: e.target.checked,
                    }))
                  }
                >
                  Hide from user-facing catalog views
                </Checkbox>
              </Space>
            )}
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {publishMode === "copy" && publishCopyMode === "project"
                ? "Publishing creates a new immutable managed RootFS reference. The current project keeps its existing live upperdir and is not automatically switched to that new image."
                : "This saves catalog metadata for the current image string without creating a new managed RootFS artifact."}
            </Paragraph>
          </Space>
        </Modal>
      )}
    </div>
  );
}

function getImage(project, fallback: string) {
  const image = project?.get("rootfs_image")?.trim();
  return image ? image : fallback;
}

async function getImages(project_id: string) {
  const fs = redux.getProjectActions(project_id).fs();
  const { stdout } = await fs.fd(join(PROJECT_IMAGE_PATH, "0"), {
    options: ["-E", "workdir", "-E", "upperdir"],
  });
  const v = Buffer.from(stdout)
    .toString()
    .split("\n")
    .map((x) => x.slice(0, -1))
    .filter((x) => x);
  const X = new Set(v);
  X.add(DEFAULT_PROJECT_IMAGE);
  const notLeaf = new Set<string>();
  for (const w of X) {
    notLeaf.add(dirname(w));
  }
  const w: string[] = [];
  for (const y of X) {
    if (notLeaf.has(y)) continue;
    w.push(y);
  }
  return w;
}

async function setRootFilesystemImage({
  project_id,
  image,
  image_id,
}: {
  project_id: string;
  image: string;
  image_id?: string;
}) {
  await webapp_client.query({
    query: {
      projects: {
        project_id,
        rootfs_image: image,
        rootfs_image_id: image_id ?? "",
      },
    },
  });
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
    Array<{ label: string; options: Array<{ value: string; label: string }> }>
  >((acc, { key, label }) => {
    const options = images
      .filter((entry) => entry.section === key)
      .map((entry) => ({
        value: entry.id,
        label: entry.label || entry.image,
      }));
    if (options.length > 0) {
      acc.push({ label, options });
    }
    return acc;
  }, []);
}

function publishActionLabel(entry?: RootfsImageEntry): string {
  if (entry?.section === "mine" && entry.can_manage) {
    return "Manage Catalog…";
  }
  return "Save to My Images…";
}

function renderRootfsWarning(
  entry: RootfsImageEntry,
): React.JSX.Element | undefined {
  if (entry.warning === "collaborator") {
    return (
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Published by one of your collaborators. Review it before using it in a
        shared or teaching context.
      </Paragraph>
    );
  }
  if (entry.warning === "public") {
    return (
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Public community image. Treat it cautiously unless you trust its
        publisher and contents.
      </Paragraph>
    );
  }
}
