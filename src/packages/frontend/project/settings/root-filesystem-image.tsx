/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
import ActionAssist from "@cocalc/frontend/components/action-assist";
import { Icon, Paragraph } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  dispatchNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
} from "@cocalc/frontend/project/new/navigator-intents";
import RootfsPublishOps from "@cocalc/frontend/project/settings/rootfs-publish-ops";
import {
  getProjectRootfsStates,
  invalidateRootfsImageCache,
  managedRootfsCatalogUrl,
  publishProjectRootfsImage,
  saveRootfsCatalogEntry,
  setProjectRootfsImage,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { split } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import type {
  ProjectRootfsStateEntry,
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
  const [catalogRefresh, setCatalogRefresh] = useState<number>(0);
  const [projectRootfsStates, setProjectRootfsStates] = useState<
    ProjectRootfsStateEntry[]
  >([]);
  const [publishMode, setPublishMode] = useState<"copy" | "manage">("copy");
  const [publishCopyMode, setPublishCopyMode] = useState<"project" | "base">(
    "project",
  );
  const [publishAdvanced, setPublishAdvanced] = useState<boolean>(false);
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
  const currentProjectRootfsState = useMemo(
    () => projectRootfsStates.find((state) => state.state_role === "current"),
    [projectRootfsStates],
  );
  const previousProjectRootfsState = useMemo(
    () => projectRootfsStates.find((state) => state.state_role === "previous"),
    [projectRootfsStates],
  );
  const currentProjectRootfsEntry = useMemo(() => {
    if (!currentProjectRootfsState) return undefined;
    if (currentProjectRootfsState.image_id) {
      const byId = rootfsImages.find(
        (entry) => entry.id === currentProjectRootfsState.image_id,
      );
      if (byId) return byId;
    }
    return rootfsImages.find(
      (entry) => entry.image === currentProjectRootfsState.image,
    );
  }, [currentProjectRootfsState, rootfsImages]);
  const previousProjectRootfsEntry = useMemo(() => {
    if (!previousProjectRootfsState) return undefined;
    if (previousProjectRootfsState.image_id) {
      const byId = rootfsImages.find(
        (entry) => entry.id === previousProjectRootfsState.image_id,
      );
      if (byId) return byId;
    }
    return rootfsImages.find(
      (entry) => entry.image === previousProjectRootfsState.image,
    );
  }, [previousProjectRootfsState, rootfsImages]);
  const currentDisplayEntry = useMemo(() => {
    if (!currentProjectRootfsState) return undefined;
    if (
      currentProjectRootfsEntry &&
      currentProjectRootfsEntry.image === currentProjectRootfsState.image
    ) {
      return currentProjectRootfsEntry;
    }
    if (
      selectedRootfsEntry &&
      selectedRootfsEntry.image === currentProjectRootfsState.image
    ) {
      return selectedRootfsEntry;
    }
    return currentProjectRootfsEntry ?? selectedRootfsEntry;
  }, [
    currentProjectRootfsEntry,
    currentProjectRootfsState,
    selectedRootfsEntry,
  ]);
  const activeDisplayEntry = currentDisplayEntry ?? selectedRootfsEntry;
  const relatedVersionEntries = useMemo(() => {
    if (!currentDisplayEntry?.family) return [];
    return rootfsImages
      .filter(
        (entry) =>
          entry.id !== currentDisplayEntry.id &&
          entry.family === currentDisplayEntry.family &&
          !entry.hidden &&
          !entry.blocked &&
          (!currentDisplayEntry.channel ||
            entry.channel === currentDisplayEntry.channel),
      )
      .sort((a, b) => compareRootfsVersionEntries(a, b));
  }, [currentDisplayEntry, rootfsImages]);
  const suggestedUpgradeEntry = useMemo(() => {
    if (!currentDisplayEntry) return undefined;
    const explicitUpgrade = relatedVersionEntries.find(
      (entry) => entry.supersedes_image_id === currentDisplayEntry.id,
    );
    if (explicitUpgrade) return explicitUpgrade;
    if (!currentDisplayEntry.version) return undefined;
    const newerVersions = relatedVersionEntries.filter(
      (entry) =>
        !!entry.version &&
        compareRootfsVersions(entry.version, currentDisplayEntry.version!) > 0,
    );
    return newerVersions[0];
  }, [currentDisplayEntry, relatedVersionEntries]);
  const publishAssistCommand = useMemo(
    () =>
      buildRootfsPublishAssistCommand({
        projectId: project_id,
        publishMode,
        publishCopyMode,
        publishDraft,
        publishSourceEntry,
      }),
    [
      project_id,
      publishMode,
      publishCopyMode,
      publishDraft,
      publishSourceEntry,
    ],
  );

  useEffect(() => {
    const nextImage = getImage(project, effectiveDefaultRootfs);
    setValue(nextImage);
    setImageId(project?.get("rootfs_image_id", "")?.trim() ?? "");
  }, [effectiveDefaultRootfs, project]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const states = await getProjectRootfsStates(project_id);
        if (!active) return;
        setProjectRootfsStates(states);
      } catch {
        if (!active) return;
        setProjectRootfsStates([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [project_id]);

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
      invalidateRootfsImageCache();
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

  function openUpgradeDialog(entry: RootfsImageEntry) {
    setRootfsMode("catalog");
    setRootfsDraft(entry.image);
    setRootfsDraftId(entry.id);
    setOpen(true);
  }

  function openPublishDialog(opts?: {
    image?: string;
    entry?: RootfsImageEntry;
    publishMode?: "copy" | "manage";
    copyMode?: "project" | "base";
  }) {
    const currentImage = opts?.image?.trim() || value || effectiveDefaultRootfs;
    const currentEntry = opts?.entry ?? selectedRootfsEntry;
    const defaultMode = opts?.publishMode ?? "copy";
    setPublishSourceEntry(currentEntry);
    setPublishMode(defaultMode);
    setPublishCopyMode(opts?.copyMode ?? "project");
    setPublishAdvanced(false);
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
      const states = await switchProjectRootfs({
        project_id,
        image: nextImage,
        image_id: nextImageId,
      });
      setProjectRootfsStates(states);
      const currentState = states.find(
        (state) => state.state_role === "current",
      );
      setValue(currentState?.image ?? nextImage);
      setImageId(currentState?.image_id ?? nextImageId ?? "");
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

  async function rollbackToPreviousRootfs() {
    if (!previousProjectRootfsState || !project) return;
    try {
      setSaving(true);
      const states = await switchProjectRootfs({
        project_id: project.get("project_id"),
        image: previousProjectRootfsState.image,
        image_id: previousProjectRootfsState.image_id,
      });
      setProjectRootfsStates(states);
      const currentState = states.find(
        (state) => state.state_role === "current",
      );
      setValue(currentState?.image ?? previousProjectRootfsState.image);
      setImageId(
        currentState?.image_id ?? previousProjectRootfsState.image_id ?? "",
      );
      if (project.getIn(["state", "state"]) == "running") {
        redux.getActions("projects").restart_project(project.get("project_id"));
      }
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

  async function sendPublishAssistToAgent() {
    const prompt = buildRootfsPublishAgentPrompt({
      projectId: project_id,
      command: publishAssistCommand,
      publishMode,
      publishCopyMode,
      publishDraft,
      publishSourceEntry,
    });
    try {
      const sent = await submitNavigatorPromptToCurrentThread({
        project_id,
        prompt,
        title:
          publishMode === "copy" && publishCopyMode === "project"
            ? "Publish RootFS"
            : publishMode === "manage"
              ? "Update RootFS Catalog Entry"
              : "Save RootFS Image",
        tag: "intent:rootfs-publish",
        forceCodex: true,
        openFloating: true,
        codexConfig: {
          sessionMode: "full-access",
          allowWrite: true,
          workingDirectory: getProjectHomeDirectory(project_id),
        },
      });
      if (!sent) {
        dispatchNavigatorPromptIntent({
          prompt,
          title:
            publishMode === "copy" && publishCopyMode === "project"
              ? "Publish RootFS"
              : publishMode === "manage"
                ? "Update RootFS Catalog Entry"
                : "Save RootFS Image",
          tag: "intent:rootfs-publish",
          forceCodex: true,
          codexConfig: {
            sessionMode: "full-access",
            allowWrite: true,
            workingDirectory: getProjectHomeDirectory(project_id),
          },
        });
      }
    } catch (err) {
      setError(`${err}`);
      throw err;
    }
  }

  return (
    <div style={{ marginTop: "-4px", marginLeft: "-10px" }}>
      <RootfsPublishOps project_id={project_id} />
      <div style={{ marginLeft: "15px" }}>
        <Paragraph style={{ marginBottom: "6px" }}>
          <strong>{activeDisplayEntry?.label || value}</strong>
        </Paragraph>
        <Space wrap style={{ marginBottom: "6px" }}>
          {activeDisplayEntry?.section && (
            <Tag color={sectionTagColor(activeDisplayEntry.section)}>
              {sectionLabel(activeDisplayEntry.section)}
            </Tag>
          )}
          {activeDisplayEntry?.version && (
            <Tag>{activeDisplayEntry.version}</Tag>
          )}
          {activeDisplayEntry?.channel && (
            <Tag color="cyan">{activeDisplayEntry.channel}</Tag>
          )}
          {activeDisplayEntry?.gpu && <Tag color="purple">GPU image</Tag>}
        </Space>
        <code style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
          {value || effectiveDefaultRootfs}
        </code>
        <Paragraph
          type="secondary"
          style={{ marginTop: "8px", marginBottom: 0 }}
        >
          Publish to reuse software and <code>/</code>-filesystem customizations
          in your other projects, with collaborators, with students, or
          publicly.
        </Paragraph>
        <Space wrap style={{ marginTop: "10px" }}>
          <Button
            type="primary"
            disabled={open}
            onClick={() =>
              openPublishDialog({
                image: value || effectiveDefaultRootfs,
                entry: selectedRootfsEntry,
                publishMode: "copy",
                copyMode: "project",
              })
            }
          >
            Publish current RootFS...
          </Button>
          <Button disabled={open} onClick={openPicker}>
            Change / upgrade image...
          </Button>
          {previousProjectRootfsState && (
            <Button
              disabled={open || saving}
              onClick={rollbackToPreviousRootfs}
            >
              Switch back to previous image
            </Button>
          )}
        </Space>
        {suggestedUpgradeEntry && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: "14px", maxWidth: "760px" }}
            message={
              <>
                Upgrade available:{" "}
                <strong>
                  {displayRootfsLabel(
                    suggestedUpgradeEntry,
                    suggestedUpgradeEntry.image,
                  )}
                </strong>
              </>
            }
            description={
              <>
                Switch from{" "}
                <code>
                  {displayRootfsLabel(
                    activeDisplayEntry,
                    value || effectiveDefaultRootfs,
                  )}
                </code>{" "}
                to{" "}
                <code>
                  {displayRootfsLabel(
                    suggestedUpgradeEntry,
                    suggestedUpgradeEntry.image,
                  )}
                </code>
                . This changes the visible <code>/</code> software environment,
                but your current RootFS remains available as a rollback target.
              </>
            }
            action={
              <Button
                size="small"
                onClick={() => openUpgradeDialog(suggestedUpgradeEntry)}
              >
                Review upgrade
              </Button>
            }
          />
        )}
      </div>
      {(currentProjectRootfsState || previousProjectRootfsState) && (
        <div
          style={{
            marginLeft: "15px",
            marginTop: "16px",
            color: COLORS.GRAY_D,
            borderLeft: `3px solid ${COLORS.GRAY_L}`,
            paddingLeft: "12px",
          }}
        >
          {currentProjectRootfsState && (
            <Paragraph type="secondary" style={{ marginBottom: "8px" }}>
              <strong>Current image:</strong>{" "}
              <code>
                {displayRootfsLabel(
                  currentDisplayEntry,
                  currentProjectRootfsState.image,
                )}
              </code>
              {currentProjectRootfsState.set_by_name
                ? ` set by ${currentProjectRootfsState.set_by_name}`
                : ""}
              {displayRootfsDetail(
                currentDisplayEntry,
                currentProjectRootfsState.image,
              )}
            </Paragraph>
          )}
          {previousProjectRootfsState && (
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <strong>Previous rollback:</strong>{" "}
              <code>
                {displayRootfsLabel(
                  previousProjectRootfsEntry,
                  previousProjectRootfsState.image,
                )}
              </code>
              {previousProjectRootfsState.set_by_name
                ? ` set by ${previousProjectRootfsState.set_by_name}`
                : ""}
              {displayRootfsDetail(
                previousProjectRootfsEntry,
                previousProjectRootfsState.image,
              )}
            </Paragraph>
          )}
        </div>
      )}
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
              Change / Upgrade RootFS Image{" "}
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
          okText="Switch image"
        >
          <Alert
            type="warning"
            showIcon
            message="Changing the image switches the visible / environment"
            description={
              <>
                Most projects should stay on their current image. Use this when
                upgrading to a newer release, rolling back, or deliberately
                moving to a different software environment. Switching back later
                restores the previous per-image <code>/</code> customizations;
                <code> /root</code> and <code>/scratch</code> remain available.
              </>
            }
            style={{ marginBottom: "12px" }}
          />
          {help && (
            <div style={{ color: "#666", marginBottom: "8px" }}>
              <p>
                Choose a managed catalog image for the normal case. Advanced
                OCI/Docker images are still possible, but they bypass CoCalc's
                catalog safety and metadata layer. You can change the image at
                any time.
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
            {rootfsMode === "catalog" &&
              currentDisplayEntry &&
              draftRootfsEntry &&
              draftRootfsEntry.id !== currentDisplayEntry.id &&
              isRelatedRootfsVersion(currentDisplayEntry, draftRootfsEntry) && (
                <Alert
                  type="info"
                  showIcon
                  message="Planned image change"
                  description={
                    <>
                      Switching from{" "}
                      <code>
                        {displayRootfsLabel(
                          currentDisplayEntry,
                          currentProjectRootfsState?.image ??
                            value ??
                            effectiveDefaultRootfs,
                        )}
                      </code>{" "}
                      to{" "}
                      <code>
                        {displayRootfsLabel(
                          draftRootfsEntry,
                          draftRootfsEntry.image,
                        )}
                      </code>
                      . After the switch, this project can still roll back to
                      the previous RootFS state.
                    </>
                  }
                />
              )}
            {rootfsMode === "catalog" ? (
              <>
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  Pick a managed catalog image. These entries have CoCalc
                  metadata, visibility, and lifecycle management on top of the
                  underlying runtime image.
                </Paragraph>
                <Select
                  showSearch
                  options={rootfsOptions}
                  value={rootfsDraftId || undefined}
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
                <Button
                  type="link"
                  onClick={() => setRootfsMode("custom")}
                  style={{ paddingLeft: 0, width: "fit-content" }}
                >
                  Use an advanced OCI or Docker image instead
                </Button>
                {draftRootfsEntry?.description && (
                  <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {draftRootfsEntry.description}
                  </Paragraph>
                )}
                {draftRootfsEntry && renderRootfsWarning(draftRootfsEntry)}
                {draftRootfsEntry && renderRootfsScan(draftRootfsEntry)}
                <Space wrap>
                  {draftRootfsEntry?.section && (
                    <Tag color={sectionTagColor(draftRootfsEntry.section)}>
                      {sectionLabel(draftRootfsEntry.section)}
                    </Tag>
                  )}
                  {draftRootfsEntry?.version && (
                    <Tag>{draftRootfsEntry.version}</Tag>
                  )}
                  {draftRootfsEntry?.channel && (
                    <Tag color="cyan">{draftRootfsEntry.channel}</Tag>
                  )}
                  {draftRootfsEntry?.gpu && <Tag color="purple">GPU image</Tag>}
                  {draftRootfsEntry?.owner_name &&
                    draftRootfsEntry.section !== "mine" && (
                      <Tag>{draftRootfsEntry.owner_name}</Tag>
                    )}
                </Space>
              </>
            ) : (
              <Space
                direction="vertical"
                size="small"
                style={{ width: "100%" }}
              >
                <Alert
                  type="warning"
                  showIcon
                  message="Advanced OCI / Docker image"
                  description={
                    <>
                      This bypasses the managed RootFS catalog. Some OCI images
                      will not work correctly with CoCalc if they are missing
                      expected basics such as certificates, shells, or standard
                      userland packages.
                    </>
                  }
                />
                <Input
                  value={rootfsDraft}
                  onChange={(e) => {
                    setRootfsDraft(e.target.value);
                    setRootfsDraftId("");
                  }}
                  allowClear
                  placeholder="e.g. ghcr.io/org/image:tag"
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
            {rootfsError && (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Catalog load issue: {rootfsError}
              </Paragraph>
            )}
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
                ? "Publish Current RootFS"
                : "Save RootFS to My Images"
          }
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {publishMode === "manage" ? (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Update catalog metadata for the currently selected RootFS entry.
              </Paragraph>
            ) : publishCopyMode === "project" ? (
              <Alert
                type="info"
                showIcon
                message="Publish a reusable RootFS image"
                description={
                  <>
                    Publish the current visible <code>/</code> software
                    environment as a managed image that can be reused in your
                    other projects, by collaborators, in courses, or publicly.
                    This does not publish <code>/root</code> or{" "}
                    <code>/scratch</code>, and it does not automatically switch
                    this project to the new image.
                  </>
                }
              />
            ) : (
              <Alert
                type="info"
                showIcon
                message="Save current base image only"
                description={
                  <>
                    This does not publish the current project state. It only
                    saves catalog metadata for the current base image so it can
                    appear under My images.
                  </>
                }
              />
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
            <Button
              type="link"
              onClick={() => setPublishAdvanced(!publishAdvanced)}
              style={{ paddingLeft: 0, width: "fit-content" }}
            >
              {publishAdvanced
                ? "Hide advanced publish options"
                : "Show advanced publish options"}
            </Button>
            {publishAdvanced && (
              <Space
                direction="vertical"
                size="middle"
                style={{ width: "100%" }}
              >
                {publishSourceEntry?.can_manage && (
                  <Checkbox
                    checked={publishMode === "manage"}
                    onChange={(e) =>
                      setPublishMode(e.target.checked ? "manage" : "copy")
                    }
                  >
                    {publishSourceEntry.section === "mine"
                      ? "Update the existing selected entry instead of saving another copy"
                      : "Edit the selected shared or official entry instead of saving my own copy"}
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
                  value={publishDraft.tags}
                  onChange={(e) =>
                    setPublishDraft((cur) => ({
                      ...cur,
                      tags: e.target.value,
                    }))
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
              </Space>
            )}
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {publishMode === "copy" && publishCopyMode === "project"
                ? "Publishing creates a new immutable managed RootFS reference. The current project keeps its existing live upperdir and is not automatically switched to that new image."
                : "This saves catalog metadata for the current image string without creating a new managed RootFS artifact."}
            </Paragraph>
            <ActionAssist
              title="Use CLI or Agent"
              description={
                publishMode === "copy" && publishCopyMode === "project"
                  ? "Preview the equivalent CLI command, or send the same publish request to the current workspace agent thread."
                  : "Preview the equivalent CLI command, or send the same catalog-save request to the current workspace agent thread."
              }
              cliTitle="RootFS CLI"
              cliCommands={[publishAssistCommand]}
              onSendAgent={sendPublishAssistToAgent}
              agentDescription="Agent support depends on the current workspace Codex session. Restart-sensitive actions such as changing the project image still need more care than publishing."
            />
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

async function setRootFilesystemImage({
  project_id,
  image,
  image_id,
}: {
  project_id: string;
  image: string;
  image_id?: string;
}) {
  return await setProjectRootfsImage({
    project_id,
    image,
    image_id,
  });
}

async function switchProjectRootfs({
  project_id,
  image,
  image_id,
}: {
  project_id: string;
  image: string;
  image_id?: string;
}) {
  const parts = split(image.trim() ? image.trim() : DEFAULT_PROJECT_IMAGE);
  const normalizedImage = parts.slice(-1)[0];
  return await setRootFilesystemImage({
    project_id,
    image: normalizedImage,
    image_id,
  });
}

function displayRootfsLabel(
  entry: RootfsImageEntry | undefined,
  fallbackImage: string,
): string {
  return entry?.label?.trim() || fallbackImage;
}

function displayRootfsDetail(
  entry: RootfsImageEntry | undefined,
  fallbackImage: string,
): string {
  const detail = entry?.image?.trim() || fallbackImage;
  const label = entry?.label?.trim();
  return detail && detail !== label ? ` (${detail})` : "";
}

function isRelatedRootfsVersion(
  current: RootfsImageEntry | undefined,
  next: RootfsImageEntry | undefined,
): boolean {
  if (!current || !next) return false;
  if (current.id === next.id) return false;
  if (next.supersedes_image_id === current.id) return true;
  return !!current.family && current.family === next.family;
}

function compareRootfsVersionEntries(
  a: RootfsImageEntry,
  b: RootfsImageEntry,
): number {
  const versionCompare = compareRootfsVersions(b.version, a.version);
  if (versionCompare !== 0) return versionCompare;
  return `${a.label || a.image}`.localeCompare(
    `${b.label || b.image}`,
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
}

function compareRootfsVersions(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (a && !b) return 1;
  if (!a && b) return -1;
  return `${a}`.localeCompare(`${b}`, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function buildRootfsPublishAssistCommand(opts: {
  projectId: string;
  publishMode: "copy" | "manage";
  publishCopyMode: "project" | "base";
  publishDraft: PublishDraft;
  publishSourceEntry?: RootfsImageEntry;
}): string {
  const {
    projectId,
    publishMode,
    publishCopyMode,
    publishDraft,
    publishSourceEntry,
  } = opts;
  const parts: string[] =
    publishMode === "copy" && publishCopyMode === "project"
      ? [
          "cocalc",
          "rootfs",
          "publish",
          "--project",
          shellQuoteCliArg(projectId),
          "--label",
          shellQuoteCliArg(publishDraft.label),
          "--wait",
        ]
      : [
          "cocalc",
          "rootfs",
          "save",
          "--image",
          shellQuoteCliArg(publishDraft.image),
          "--label",
          shellQuoteCliArg(publishDraft.label),
        ];
  if (publishMode === "manage" && publishSourceEntry?.can_manage) {
    pushCliOption(parts, "--image-id", publishSourceEntry.id);
  }
  pushCliOption(parts, "--description", publishDraft.description);
  if (publishDraft.visibility) {
    pushCliOption(parts, "--visibility", publishDraft.visibility);
  }
  pushCliOption(parts, "--tags", publishDraft.tags);
  if (publishDraft.official) parts.push("--official");
  if (publishDraft.prepull) parts.push("--prepull");
  if (publishDraft.hidden) parts.push("--hidden");
  return parts.join(" ");
}

function buildRootfsPublishAgentPrompt(opts: {
  projectId: string;
  command: string;
  publishMode: "copy" | "manage";
  publishCopyMode: "project" | "base";
  publishDraft: PublishDraft;
  publishSourceEntry?: RootfsImageEntry;
}): string {
  const {
    projectId,
    command,
    publishMode,
    publishCopyMode,
    publishDraft,
    publishSourceEntry,
  } = opts;
  const lines = [
    publishMode === "copy" && publishCopyMode === "project"
      ? `Publish the current RootFS of project ${projectId} as a managed CoCalc image.`
      : publishMode === "manage"
        ? `Update the existing RootFS catalog entry for project ${projectId}.`
        : `Save the current base image of project ${projectId} into the RootFS catalog.`,
    "",
    "Use the CoCalc CLI for this action:",
    "```sh",
    command,
    "```",
    "",
    publishMode === "copy" && publishCopyMode === "project"
      ? "Important: this publishes the current visible / software environment. It does not publish /root or /scratch, and it does not automatically switch the project to the new image."
      : publishMode === "manage"
        ? `Important: update the existing catalog entry${publishSourceEntry?.label ? ` (${publishSourceEntry.label})` : ""} instead of creating another copy.`
        : "Important: this only saves catalog metadata for the current base image. It does not create a new managed RootFS artifact from the live project state.",
    "",
    "Desired metadata:",
    `- label: ${publishDraft.label}`,
    `- description: ${publishDraft.description || "(empty)"}`,
    `- visibility: ${publishDraft.visibility}`,
    `- tags: ${publishDraft.tags || "(none)"}`,
    `- official: ${publishDraft.official ? "yes" : "no"}`,
    `- prepull: ${publishDraft.prepull ? "yes" : "no"}`,
    `- hidden: ${publishDraft.hidden ? "yes" : "no"}`,
    "",
    "After the action completes, report the resulting image name, image_id/release_id if available, and whether the action succeeded cleanly.",
  ];
  return lines.join("\n");
}

function pushCliOption(parts: string[], flag: string, value?: string) {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return;
  parts.push(flag, shellQuoteCliArg(trimmed));
}

function shellQuoteCliArg(value: string): string {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
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
