/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from "antd";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import ActionAssist from "@cocalc/frontend/components/action-assist";
import { Icon, Paragraph, ThemeEditorModal } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { useProjectRootfs } from "@cocalc/frontend/project/use-project-rootfs";
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
  scanProjectRootfs,
  setProjectRootfsImage,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import {
  latestRootfsVersionEntries,
  latestRootfsUpgradeEntry,
  RootfsThemePreview,
  sectionLabel,
  sectionTagColor,
} from "@cocalc/frontend/rootfs/catalog-ui";
import { rootfsPath } from "@cocalc/frontend/public/rootfs/routes";
import {
  RootfsScanDetailsButton,
  RootfsScanStatus,
  useRootfsScanEnabled,
} from "@cocalc/frontend/rootfs/scan-status";
import {
  ROOTFS_PROJECT_PRESET_LABELS,
  ROOTFS_PROJECT_PRESET_TAGS,
  type RootfsProjectPreset,
} from "@cocalc/frontend/rootfs/project-presets";
import { queueRootfsChangeRestart } from "./rootfs-restart";
import { themeDraftFromTheme } from "@cocalc/frontend/theme/types";
import { docsPath } from "@cocalc/docs";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { split } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  ROOTFS_CONFIG_EXPORT_KIND,
  ROOTFS_CONFIG_EXPORT_VERSION,
  isManagedRootfsImageName,
  normalizeRootfsContentManifest,
  parseRootfsConfigExport,
  validateRootfsSlug,
} from "@cocalc/util/rootfs-images";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  RootfsContentManifestBuilder,
  emptyRootfsContentDraft,
  launchRootfsProjectAppAction,
  renderRootfsContentPanel,
  renderRootfsContentPreview,
  rootfsContentCatalogPayload,
  rootfsContentDraftToInput,
  rootfsContentManifestToDraft,
  rootfsCopyTargetPath,
  type RootfsContentDirectoryPicker,
  type RootfsContentDraft,
} from "./rootfs-content";
import {
  buildRootfsPublishAgentPrompt,
  buildRootfsPublishAssistCommand,
  rootfsThemeFromPublishDraft,
  type PublishDraft,
} from "./rootfs-publish-assist";
import { RuntimeAction, RuntimePanel } from "./rootfs-runtime-panel";
import type {
  RootfsConfigExport,
  RootfsConfigExportMetadata,
  ProjectRootfsStateEntry,
  RootfsImageEntry,
  RootfsImageTheme,
} from "@cocalc/util/rootfs-images";
import type { RootfsProjectPreflightScanResult } from "@cocalc/util/rootfs-scan";

type RootfsConfigImportOptions = {
  metadata: boolean;
  theme: boolean;
  content: boolean;
};

type RootFilesystemImageMode = "inline" | "flyout" | "modal" | "page";

interface RootFilesystemImageProps {
  mode?: RootFilesystemImageMode;
}

interface RootFilesystemImageModalProps {
  onClose: () => void;
  open: boolean;
}

export default function RootFilesystemImage({
  mode = "inline",
}: RootFilesystemImageProps = {}) {
  const isFlyout = mode === "flyout";
  const isModal = mode === "modal";
  const isPage = mode === "page";
  const { actions, project, project_id } = useProjectContext();
  const [open, setOpen] = useState<boolean>(false);
  const [upgradeOpen, setUpgradeOpen] = useState<boolean>(false);
  const [publishOpen, setPublishOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [scanningLiveRootfs, setScanningLiveRootfs] = useState<boolean>(false);
  const [restartQueuedAt, setRestartQueuedAt] = useState<string>("");
  const [liveRootfsScan, setLiveRootfsScan] =
    useState<RootfsProjectPreflightScanResult>();
  const [savingLiveScanDetails, setSavingLiveScanDetails] =
    useState<boolean>(false);
  const [help, setHelp] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [imageId, setImageId] = useState<string>("");
  const [rootfsMode, setRootfsMode] = useState<"catalog" | "custom">("catalog");
  const [rootfsDraft, setRootfsDraft] = useState<string>("");
  const [rootfsDraftId, setRootfsDraftId] = useState<string>("");
  const [catalogRefresh, setCatalogRefresh] = useState<number>(0);
  const [showOlderVersions, setShowOlderVersions] = useState<boolean>(false);
  const [rootfsSearch, setRootfsSearch] = useState<string>("");
  const [projectRootfsStates, setProjectRootfsStates] = useState<
    ProjectRootfsStateEntry[]
  >([]);
  const [publishMode, setPublishMode] = useState<"copy" | "manage">("copy");
  const [publishCopyMode, setPublishCopyMode] = useState<"project" | "base">(
    "project",
  );
  const [switchPublishedProject, setSwitchPublishedProject] =
    useState<boolean>(true);
  const [publishThemeOpen, setPublishThemeOpen] = useState<boolean>(false);
  const [publishTab, setPublishTab] = useState<string>("metadata");
  const [publishContentDraft, setPublishContentDraft] =
    useState<RootfsContentDraft>(() => emptyRootfsContentDraft());
  const [publishContentPicker, setPublishContentPicker] =
    useState<RootfsContentDirectoryPicker>(null);
  const rootfsConfigImportInputRef = useRef<HTMLInputElement | null>(null);
  const [rootfsConfigImportCandidate, setRootfsConfigImportCandidate] =
    useState<RootfsConfigExport | null>(null);
  const [rootfsConfigImportProjectPath, setRootfsConfigImportProjectPath] =
    useState<string>("");
  const [
    rootfsConfigImportProjectLoading,
    setRootfsConfigImportProjectLoading,
  ] = useState<boolean>(false);
  const [rootfsConfigImportOptions, setRootfsConfigImportOptions] =
    useState<RootfsConfigImportOptions>(() => ({
      metadata: true,
      theme: true,
      content: true,
    }));
  const [publishSourceEntry, setPublishSourceEntry] =
    useState<RootfsImageEntry>();
  const [publishDraft, setPublishDraft] = useState<PublishDraft>({
    image: DEFAULT_PROJECT_IMAGE,
    label: "",
    slug: "",
    description: "",
    family: "",
    version: "",
    channel: "",
    supersedes_image_id: "",
    default_jupyter_kernel: "",
    theme: themeDraftFromTheme(null),
    visibility: "private",
    tags: "",
    official: false,
    prepull: false,
    hidden: false,
  });
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

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
  const canUseCustomRootfs = isAdmin;
  const rootfsScanEnabled = useRootfsScanEnabled();
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
  } = useRootfsImages([managedRootfsCatalogUrl(catalogRefresh)], {
    query: rootfsSearch,
    limit: 200,
  });
  const selectableRootfsImages = useMemo(
    () =>
      canUseCustomRootfs
        ? rootfsImages
        : rootfsImages.filter((entry) => rootfsEntryIsManaged(entry)),
    [canUseCustomRootfs, rootfsImages],
  );

  const selectedRootfsEntry = useMemo(() => {
    const selectedId = imageId.trim();
    if (selectedId) {
      return selectableRootfsImages.find((entry) => entry.id === selectedId);
    }
    const image = value.trim();
    if (!image) return undefined;
    return selectableRootfsImages.find((entry) => entry.image === image);
  }, [imageId, selectableRootfsImages, value]);

  const draftRootfsEntry = useMemo(() => {
    const selectedId = rootfsDraftId.trim();
    if (selectedId) {
      return selectableRootfsImages.find((entry) => entry.id === selectedId);
    }
    const image = rootfsDraft.trim();
    if (!image) return undefined;
    return selectableRootfsImages.find((entry) => entry.image === image);
  }, [rootfsDraft, rootfsDraftId, selectableRootfsImages]);

  const currentProjectRootfsState = useMemo(
    () => projectRootfsStates.find((state) => state.state_role === "current"),
    [projectRootfsStates],
  );
  const previousProjectRootfsState = useMemo(
    () => projectRootfsStates.find((state) => state.state_role === "previous"),
    [projectRootfsStates],
  );
  const initialRootfs = useMemo(() => {
    const image = `${currentProjectRootfsState?.image ?? ""}`.trim();
    if (!image) {
      return undefined;
    }
    const image_id = `${currentProjectRootfsState?.image_id ?? ""}`.trim();
    return {
      image,
      ...(image_id ? { image_id } : undefined),
    };
  }, [currentProjectRootfsState?.image, currentProjectRootfsState?.image_id]);
  const { rootfs, setRootfs } = useProjectRootfs(project_id, initialRootfs);
  const currentProjectRootfsEntry = useMemo(() => {
    if (!currentProjectRootfsState) return undefined;
    if (currentProjectRootfsState.image_id) {
      const byId = selectableRootfsImages.find(
        (entry) => entry.id === currentProjectRootfsState.image_id,
      );
      if (byId) return byId;
    }
    return selectableRootfsImages.find(
      (entry) => entry.image === currentProjectRootfsState.image,
    );
  }, [currentProjectRootfsState, selectableRootfsImages]);
  const previousProjectRootfsEntry = useMemo(() => {
    if (!previousProjectRootfsState) return undefined;
    if (previousProjectRootfsState.image_id) {
      const byId = selectableRootfsImages.find(
        (entry) => entry.id === previousProjectRootfsState.image_id,
      );
      if (byId) return byId;
    }
    return selectableRootfsImages.find(
      (entry) => entry.image === previousProjectRootfsState.image,
    );
  }, [previousProjectRootfsState, selectableRootfsImages]);
  const currentDisplayEntry = useMemo(() => {
    const liveImage = value.trim();
    const liveImageId = imageId.trim();
    if (selectedRootfsEntry) {
      return selectedRootfsEntry;
    }
    if (
      liveImage &&
      currentProjectRootfsState?.image &&
      liveImage !== currentProjectRootfsState.image
    ) {
      return undefined;
    }
    if (
      liveImageId &&
      currentProjectRootfsState?.image_id &&
      liveImageId !== currentProjectRootfsState.image_id
    ) {
      return undefined;
    }
    if (!currentProjectRootfsState) return undefined;
    if (
      currentProjectRootfsEntry &&
      currentProjectRootfsEntry.image === currentProjectRootfsState.image
    ) {
      return currentProjectRootfsEntry;
    }
    return currentProjectRootfsEntry;
  }, [
    currentProjectRootfsEntry,
    currentProjectRootfsState,
    imageId,
    selectedRootfsEntry,
    value,
  ]);
  const activeDisplayEntry = currentDisplayEntry;
  const pickerRootfsImages = useMemo(
    () =>
      latestRootfsVersionEntries(selectableRootfsImages, {
        showOlderVersions,
        preserveIds: [rootfsDraftId, imageId, currentDisplayEntry?.id],
      }),
    [
      currentDisplayEntry?.id,
      imageId,
      rootfsDraftId,
      selectableRootfsImages,
      showOlderVersions,
    ],
  );
  const relatedVersionEntries = useMemo(() => {
    if (!currentDisplayEntry?.family) return [];
    return selectableRootfsImages
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
  }, [currentDisplayEntry, selectableRootfsImages]);
  const suggestedUpgradeEntry = useMemo(() => {
    return latestRootfsUpgradeEntry({
      current: currentDisplayEntry,
      images: relatedVersionEntries,
    });
  }, [currentDisplayEntry, relatedVersionEntries]);
  const filteredPickerRootfsImages = useMemo(() => {
    const query = rootfsSearch.trim().toLowerCase();
    if (!query) return pickerRootfsImages;
    return pickerRootfsImages.filter((entry) =>
      rootfsCatalogSearchText(entry).includes(query),
    );
  }, [pickerRootfsImages, rootfsSearch]);
  const visiblePickerRootfsImages = useMemo(() => {
    if (!suggestedUpgradeEntry) return filteredPickerRootfsImages;
    return [...filteredPickerRootfsImages].sort((a, b) => {
      if (a.id === suggestedUpgradeEntry.id) return -1;
      if (b.id === suggestedUpgradeEntry.id) return 1;
      return 0;
    });
  }, [filteredPickerRootfsImages, suggestedUpgradeEntry]);
  const publishAssistCommand = useMemo(
    () =>
      buildRootfsPublishAssistCommand({
        projectId: project_id,
        publishMode,
        publishCopyMode,
        publishDraft,
        publishSourceEntry,
        switchPublishedProject,
      }),
    [
      project_id,
      publishMode,
      publishCopyMode,
      publishDraft,
      publishSourceEntry,
      switchPublishedProject,
    ],
  );
  const rootfsLandingPath = rootfsPublicLandingPath({
    publishDraft,
    publishSourceEntry,
  });
  const rootfsLandingUrl = absoluteRootfsPublicUrl(rootfsLandingPath);
  const publishSlugError = useMemo(
    () => rootfsSlugValidationError(publishDraft.slug),
    [publishDraft.slug],
  );
  const normalizedPublishSlug = useMemo(
    () => rootfsNormalizedSlug(publishDraft.slug),
    [publishDraft.slug],
  );
  const publishTagOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...rootfsImages.flatMap((entry) => entry.tags ?? []),
            ...Object.values(ROOTFS_PROJECT_PRESET_TAGS).flat(),
          ].filter(Boolean),
        ),
      )
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .map((tag) => ({ label: tag, value: tag })),
    [rootfsImages],
  );
  const publishFamilyOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rootfsImages.map((entry) => entry.family?.trim()).filter(Boolean),
        ),
      )
        .sort((a, b) =>
          `${a}`.localeCompare(`${b}`, undefined, { sensitivity: "base" }),
        )
        .map((family) => ({ label: family, value: family })),
    [rootfsImages],
  );
  const publishChannelOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rootfsImages.map((entry) => entry.channel?.trim()).filter(Boolean),
        ),
      )
        .sort((a, b) =>
          `${a}`.localeCompare(`${b}`, undefined, { sensitivity: "base" }),
        )
        .map((channel) => ({ label: channel, value: channel })),
    [rootfsImages],
  );
  const publishSupersedesOptions = useMemo(
    () =>
      rootfsImages
        .filter((entry) => entry.id !== publishSourceEntry?.id)
        .map((entry) => ({
          value: entry.id,
          label: `${entry.label || entry.image}${entry.version ? ` (${entry.version})` : ""}`,
        })),
    [publishSourceEntry?.id, rootfsImages],
  );
  const publishContentInput = useMemo(
    () => rootfsContentDraftToInput(publishContentDraft),
    [publishContentDraft],
  );
  const publishContentValidation = useMemo(
    () => normalizeRootfsContentManifest(publishContentInput),
    [publishContentInput],
  );
  const publishContentPreviewEntry = useMemo<RootfsImageEntry>(
    () =>
      ({
        id: "rootfs-content-preview",
        image: publishDraft.image || DEFAULT_PROJECT_IMAGE,
        label: publishDraft.label || "Image",
        description: publishDraft.description || undefined,
        theme:
          rootfsThemeFromPublishDraft(publishDraft) ??
          publishSourceEntry?.theme,
        content: publishContentValidation.content,
      }) as RootfsImageEntry,
    [
      publishContentValidation.content,
      publishDraft.description,
      publishDraft.image,
      publishDraft.label,
      publishDraft.theme,
      publishSourceEntry?.theme,
    ],
  );

  useEffect(() => {
    const nextImage = getImage(rootfs, effectiveDefaultRootfs);
    setValue(nextImage);
    setImageId(rootfs?.image_id?.trim() ?? "");
  }, [effectiveDefaultRootfs, rootfs]);

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
  }, [project_id, rootfs?.image, rootfs?.image_id]);

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
    const current = getImage(rootfs, effectiveDefaultRootfs);
    const currentId = rootfs?.image_id?.trim() ?? "";
    const currentEntry =
      selectableRootfsImages.find((entry) => entry.id === currentId) ??
      selectableRootfsImages.find((entry) => entry.image === current);
    setRootfsDraft(currentEntry?.image ?? current);
    setRootfsDraftId(currentEntry?.id ?? "");
    setRootfsMode(currentEntry || !canUseCustomRootfs ? "catalog" : "custom");
    setRootfsSearch("");
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
    const nextLabel =
      currentEntry?.label ||
      currentImage.split("/").slice(-1)[0] ||
      "Custom Image";
    const nextDescription = currentEntry?.description ?? "";
    const defaultMode = opts?.publishMode ?? "copy";
    const defaultCopyMode = opts?.copyMode ?? "project";
    setPublishSourceEntry(currentEntry);
    setPublishMode(defaultMode);
    setPublishCopyMode(defaultCopyMode);
    setPublishTab(
      defaultMode === "copy" && defaultCopyMode === "project"
        ? "publish"
        : "metadata",
    );
    setPublishDraft({
      image: currentImage,
      label: nextLabel,
      slug: currentEntry?.slug ?? "",
      description: nextDescription,
      family: currentEntry?.family ?? "",
      version: currentEntry?.version ?? "",
      channel: currentEntry?.channel ?? "",
      default_jupyter_kernel: currentEntry?.default_jupyter_kernel ?? "",
      supersedes_image_id:
        defaultMode === "manage"
          ? (currentEntry?.supersedes_image_id ?? "")
          : (currentEntry?.id ?? ""),
      theme: {
        ...themeDraftFromTheme(currentEntry?.theme, nextLabel),
        title: nextLabel,
        description: nextDescription,
      },
      visibility: currentEntry?.visibility ?? "private",
      tags: (currentEntry?.tags ?? []).join(", "),
      official: currentEntry?.official ?? false,
      prepull: currentEntry?.prepull ?? false,
      hidden: currentEntry?.hidden ?? false,
    });
    setPublishContentDraft(rootfsContentManifestToDraft(currentEntry?.content));
    setPublishOpen(true);
  }

  async function applyProjectRootfsSelection({
    image,
    image_id,
  }: {
    image: string;
    image_id?: string;
  }) {
    if (!project) return;
    try {
      setSaving(true);
      const states = await switchProjectRootfs({
        project_id: project.get("project_id"),
        image,
        image_id,
      });
      setProjectRootfsStates(states);
      const currentState = states.find(
        (state) => state.state_role === "current",
      );
      const nextRootfsImage = currentState?.image ?? image;
      const nextRootfsImageId = currentState?.image_id ?? image_id ?? undefined;
      setRootfs({
        image: nextRootfsImage,
        ...(nextRootfsImageId ? { image_id: nextRootfsImageId } : undefined),
      });
      setValue(currentState?.image ?? image);
      setImageId(currentState?.image_id ?? image_id ?? "");
      const projectId = project.get("project_id");
      if (project.getIn(["state", "state"]) == "running") {
        await queueRootfsChangeRestart({
          project_id: projectId,
          restartProject: (project_id) =>
            redux.getActions("projects").restart_project(project_id),
          setRestartQueuedAt,
        });
      } else {
        setRestartQueuedAt("");
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function applyRootfsChange() {
    if (rootfsMode === "custom" && !canUseCustomRootfs) {
      setError("Only admins can use advanced OCI images.");
      return;
    }
    const nextEntry =
      rootfsMode === "catalog"
        ? selectableRootfsImages.find(
            (entry) => entry.id === rootfsDraftId.trim(),
          )
        : undefined;
    if (rootfsMode === "catalog" && !nextEntry) {
      setError("Choose a managed catalog image.");
      return;
    }
    const nextImage =
      rootfsMode === "custom"
        ? rootfsDraft.trim() || effectiveDefaultRootfs
        : (nextEntry?.image ?? "");
    const nextImageId =
      rootfsMode === "custom" ? undefined : nextEntry?.id?.trim() || undefined;
    await applyProjectRootfsSelection({
      image: nextImage,
      image_id: nextImageId,
    });
    setOpen(false);
  }

  async function rollbackToPreviousRootfs() {
    if (!previousProjectRootfsState) return;
    await applyProjectRootfsSelection({
      image: previousProjectRootfsState.image,
      image_id: previousProjectRootfsState.image_id,
    });
  }

  async function applySuggestedUpgrade() {
    if (!suggestedUpgradeEntry) return;
    await applyProjectRootfsSelection({
      image: suggestedUpgradeEntry.image,
      image_id: suggestedUpgradeEntry.id,
    });
    setUpgradeOpen(false);
  }

  async function saveCatalogEntry() {
    try {
      await runFreshAuthAction(async () => {
        setPublishing(true);
        try {
          if (!project) {
            throw new Error("project is not available");
          }
          const slug = validateRootfsSlug(publishDraft.slug);
          if (slug !== publishDraft.slug.trim()) {
            setPublishDraft((cur) => ({ ...cur, slug: slug ?? "" }));
          }
          const tags = publishDraft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          const contentResult =
            normalizeRootfsContentManifest(publishContentInput);
          const contentPayload = rootfsContentCatalogPayload(contentResult);
          if (publishMode === "copy" && publishCopyMode === "project") {
            setOpen(false);
            setPublishOpen(false);
            const op = await publishProjectRootfsImage({
              project_id: project.get("project_id"),
              label: publishDraft.label,
              slug,
              family: publishDraft.family.trim() || undefined,
              version: publishDraft.version.trim() || undefined,
              channel: publishDraft.channel.trim() || undefined,
              supersedes_image_id:
                publishDraft.supersedes_image_id.trim() || undefined,
              default_jupyter_kernel:
                publishDraft.default_jupyter_kernel.trim() || undefined,
              description: publishDraft.description,
              visibility: publishDraft.visibility,
              tags,
              theme: rootfsThemeFromPublishDraft(publishDraft),
              ...contentPayload,
              official: isAdmin ? publishDraft.official : undefined,
              prepull: isAdmin ? publishDraft.prepull : undefined,
              hidden: isAdmin ? publishDraft.hidden : undefined,
              switch_project: switchPublishedProject,
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
              slug,
              family: publishDraft.family.trim() || undefined,
              version: publishDraft.version.trim() || undefined,
              channel: publishDraft.channel.trim() || undefined,
              supersedes_image_id:
                publishDraft.supersedes_image_id.trim() || undefined,
              default_jupyter_kernel:
                publishDraft.default_jupyter_kernel.trim() || undefined,
              description: publishDraft.description,
              visibility: publishDraft.visibility,
              tags,
              theme: rootfsThemeFromPublishDraft(publishDraft),
              ...contentPayload,
              official: isAdmin ? publishDraft.official : undefined,
              prepull: isAdmin ? publishDraft.prepull : undefined,
              hidden: isAdmin ? publishDraft.hidden : undefined,
            });
            setPublishOpen(false);
            setPublishDraft((cur) => ({
              ...cur,
              slug: entry.slug ?? cur.slug,
            }));
            setCatalogRefresh(Date.now());
            if (entry.image === value) {
              setImageId(entry.id);
            }
            if (entry.image === rootfsDraft) {
              setRootfsDraftId(entry.id);
            }
          }
        } finally {
          setPublishing(false);
        }
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  async function saveRootfsDiscoveryConfig(): Promise<void> {
    if (publishMode === "copy" && publishCopyMode === "project") {
      message.info(
        "Discovery config is saved into catalog metadata when you publish the live project image.",
      );
      return;
    }
    try {
      await runFreshAuthAction(async () => {
        setPublishing(true);
        try {
          const slug = validateRootfsSlug(publishDraft.slug);
          if (slug !== publishDraft.slug.trim()) {
            setPublishDraft((cur) => ({ ...cur, slug: slug ?? "" }));
          }
          const tags = publishDraft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          const contentPayload = rootfsContentCatalogPayload(
            normalizeRootfsContentManifest(publishContentInput),
          );
          const entry = await saveRootfsCatalogEntry({
            image_id:
              publishMode === "manage" && publishSourceEntry?.can_manage
                ? publishSourceEntry.id
                : undefined,
            image: publishDraft.image,
            label: publishDraft.label,
            slug,
            family: publishDraft.family.trim() || undefined,
            version: publishDraft.version.trim() || undefined,
            channel: publishDraft.channel.trim() || undefined,
            supersedes_image_id:
              publishDraft.supersedes_image_id.trim() || undefined,
            default_jupyter_kernel:
              publishDraft.default_jupyter_kernel.trim() || undefined,
            description: publishDraft.description,
            visibility: publishDraft.visibility,
            tags,
            theme: rootfsThemeFromPublishDraft(publishDraft),
            ...contentPayload,
            official: isAdmin ? publishDraft.official : undefined,
            prepull: isAdmin ? publishDraft.prepull : undefined,
            hidden: isAdmin ? publishDraft.hidden : undefined,
          });
          setPublishSourceEntry(entry);
          setPublishDraft((cur) => ({
            ...cur,
            slug: entry.slug ?? cur.slug,
          }));
          setCatalogRefresh(Date.now());
          if (entry.image === value) {
            setImageId(entry.id);
          }
          if (entry.image === rootfsDraft) {
            setRootfsDraftId(entry.id);
          }
          if (contentPayload.content_warnings.length > 0) {
            message.warning("Saved discovery config with warnings.");
          } else {
            message.success("Saved discovery config.");
          }
        } finally {
          setPublishing(false);
        }
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  function exportRootfsConfig(): void {
    downloadJsonFile(
      `${safeJsonFilenamePart(publishDraft.label || "rootfs-config")}.rootfs-config.json`,
      {
        kind: ROOTFS_CONFIG_EXPORT_KIND,
        version: ROOTFS_CONFIG_EXPORT_VERSION,
        exported_at: new Date().toISOString(),
        metadata: rootfsConfigMetadataFromPublishDraft(publishDraft),
        theme: rootfsThemeFromPublishDraft(publishDraft),
        content: publishContentValidation.content,
      } satisfies RootfsConfigExport,
    );
  }

  function importRootfsConfigText(text: string): void {
    const candidate = parseRootfsConfigExport(JSON.parse(text));
    setRootfsConfigImportCandidate(candidate);
    setRootfsConfigImportOptions(rootfsConfigImportOptionsFor(candidate));
  }

  async function importRootfsConfigFile(file: File): Promise<void> {
    try {
      importRootfsConfigText(await file.text());
    } catch (err) {
      message.error(`Could not import image config: ${err}`);
    } finally {
      if (rootfsConfigImportInputRef.current) {
        rootfsConfigImportInputRef.current.value = "";
      }
    }
  }

  async function importRootfsConfigProjectFile(): Promise<void> {
    const path = rootfsConfigImportProjectPath.trim();
    if (!path) {
      message.error("Enter a project file path.");
      return;
    }
    try {
      setRootfsConfigImportProjectLoading(true);
      const text = await webapp_client.project_client.read_text_file({
        project_id,
        path,
      });
      importRootfsConfigText(text);
      message.success(`Loaded image config from ${path}.`);
    } catch (err) {
      message.error(`Could not import image config from project file: ${err}`);
    } finally {
      setRootfsConfigImportProjectLoading(false);
    }
  }

  function applyRootfsConfigImport(): void {
    const candidate = rootfsConfigImportCandidate;
    if (!candidate) return;
    const imported: string[] = [];
    if (rootfsConfigImportOptions.metadata && candidate.metadata) {
      setPublishDraft((cur) => ({
        ...cur,
        label: candidate.metadata?.label ?? cur.label,
        slug: candidate.metadata?.slug ?? cur.slug,
        description: candidate.metadata?.description ?? cur.description,
        family: candidate.metadata?.family ?? cur.family,
        version: candidate.metadata?.version ?? cur.version,
        channel: candidate.metadata?.channel ?? cur.channel,
        supersedes_image_id:
          candidate.metadata?.supersedes_image_id ?? cur.supersedes_image_id,
        default_jupyter_kernel:
          candidate.metadata?.default_jupyter_kernel ??
          cur.default_jupyter_kernel,
        visibility: candidate.metadata?.visibility ?? cur.visibility,
        tags: candidate.metadata?.tags
          ? normalizeRootfsTags(candidate.metadata.tags).join(", ")
          : cur.tags,
      }));
      imported.push("metadata");
    }
    if (rootfsConfigImportOptions.theme && candidate.theme) {
      setPublishDraft((cur) => ({
        ...cur,
        theme: themeDraftFromTheme(
          candidate.theme,
          candidate.metadata?.label ?? cur.label,
        ),
      }));
      imported.push("theme");
    }
    if (rootfsConfigImportOptions.content && candidate.content) {
      const result = normalizeRootfsContentManifest(candidate.content);
      setPublishContentDraft(rootfsContentManifestToDraft(result.content));
      imported.push("discovery config");
      if (result.warnings.length > 0) {
        message.warning(
          `Imported discovery config with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`,
        );
      }
    }
    setRootfsConfigImportCandidate(null);
    if (imported.length > 0) {
      message.success(
        `Imported ${imported.join(", ")}. Save or publish to update the catalog entry.`,
      );
    }
  }

  async function scanCurrentProjectRootfs() {
    if (!rootfsScanEnabled) {
      setError("Image vulnerability scanning is disabled for this site.");
      return;
    }
    try {
      setError("");
      setScanningLiveRootfs(true);
      const result = await scanProjectRootfs(project_id);
      setLiveRootfsScan(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setScanningLiveRootfs(false);
    }
  }

  async function saveLiveRootfsScanDetailsToProject(
    result: RootfsProjectPreflightScanResult | undefined = liveRootfsScan,
  ) {
    if (!result) return;
    const timestamp = rootfsScanReportTimestamp(result);
    const directory = "rootfs-scan-reports";
    const jsonPath = `${directory}/rootfs-scan-${timestamp}.json`;
    const markdownPath = `${directory}/rootfs-scan-${timestamp}.md`;
    try {
      setError("");
      setSavingLiveScanDetails(true);
      await webapp_client.project_client.exec({
        project_id,
        command: "mkdir",
        args: ["-p", directory],
        err_on_exit: true,
      });
      await webapp_client.project_client.write_text_file({
        project_id,
        path: jsonPath,
        content: JSON.stringify(
          {
            saved_at: new Date().toISOString(),
            source: "project-rootfs-preflight-scan",
            result,
          },
          null,
          2,
        ),
      });
      await webapp_client.project_client.write_text_file({
        project_id,
        path: markdownPath,
        content: buildLiveRootfsScanMarkdown(result, jsonPath),
      });
      actions?.open_file({ path: markdownPath, foreground: true });
      message.success("Saved image scan details to the project.");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSavingLiveScanDetails(false);
    }
  }

  function renderLiveRootfsScanActions(
    result: RootfsProjectPreflightScanResult,
  ) {
    return (
      <Space wrap size="small">
        <RootfsScanDetailsButton
          scan={result.summary}
          title="Live project image preflight scan details"
        />
        <Button
          size="small"
          loading={savingLiveScanDetails}
          onClick={() => saveLiveRootfsScanDetailsToProject(result)}
        >
          Save details to project
        </Button>
      </Space>
    );
  }

  async function sendPublishAssistToAgent() {
    const prompt = buildRootfsPublishAgentPrompt({
      projectId: project_id,
      command: publishAssistCommand,
      publishMode,
      publishCopyMode,
      publishDraft,
      publishSourceEntry,
      switchPublishedProject,
    });
    try {
      const sent = await submitNavigatorPromptToCurrentThread({
        project_id,
        prompt,
        title:
          publishMode === "copy" && publishCopyMode === "project"
            ? "Publish Image"
            : publishMode === "manage"
              ? "Update Image Catalog Entry"
              : "Save Image",
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
              ? "Publish Image"
              : publishMode === "manage"
                ? "Update Image Catalog Entry"
                : "Save Image",
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

  function generatePublishSlug(): void {
    setPublishDraft((cur) => ({
      ...cur,
      slug: generateRootfsSlugSuggestion(
        cur.label,
        publishContentDraft.title,
        publishSourceEntry?.label,
        cur.image,
      ),
    }));
  }

  function normalizePublishSlug(): void {
    setPublishDraft((cur) => ({
      ...cur,
      slug: rootfsNormalizedSlug(cur.slug),
    }));
  }

  const activeImage = value || effectiveDefaultRootfs;
  const isCustomRootfs = !rootfsLoading && !activeDisplayEntry;
  const activeLabel = activeDisplayEntry
    ? displayRootfsLabel(activeDisplayEntry, activeImage)
    : rootfsLoading
      ? "Loading image metadata..."
      : canUseCustomRootfs
        ? "Custom OCI image"
        : "Legacy/custom OCI image";
  const activeDescription =
    activeDisplayEntry?.description?.trim() ||
    (isCustomRootfs
      ? canUseCustomRootfs
        ? "This project uses a custom image string that is not in the managed catalog. It can still run, but catalog metadata, publisher details, managed upgrade suggestions, and catalog scan metadata may be unavailable."
        : "This project uses a legacy or custom OCI image. Choose a managed catalog image; only admins can set arbitrary OCI image strings."
      : "Loading managed catalog metadata for this project's image.");
  const projectIsRunning = project.getIn(["state", "state"]) == "running";

  return (
    <div
      style={
        isFlyout || isModal || isPage
          ? undefined
          : { marginTop: "-4px", marginLeft: "-10px" }
      }
    >
      <FreshAuthModal {...freshAuthModalProps} />
      <div
        style={
          isFlyout || isModal || isPage
            ? { boxSizing: "border-box", minWidth: 0, width: "100%" }
            : { marginLeft: "15px" }
        }
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div
            style={{
              ...rootfsHeroCardStyle(activeDisplayEntry),
              maxWidth: isModal || isPage ? undefined : 760,
              padding: isPage ? 24 : undefined,
            }}
          >
            <div
              style={{
                alignItems: "flex-start",
                display: "flex",
                flexWrap: isFlyout ? "wrap" : undefined,
                gap: 16,
                minWidth: 0,
              }}
            >
              {renderRootfsThemePreview(activeDisplayEntry, isPage ? 112 : 56)}
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space
                  wrap
                  size={[8, 6]}
                  style={{ marginBottom: isPage ? 10 : 6, width: "100%" }}
                >
                  <span
                    style={{
                      fontSize: isPage ? 34 : 18,
                      fontWeight: 700,
                      lineHeight: isPage ? "40px" : "24px",
                    }}
                  >
                    {activeLabel}
                  </span>
                  {isCustomRootfs ? (
                    <Tag color={canUseCustomRootfs ? "default" : "orange"}>
                      {canUseCustomRootfs
                        ? "Custom OCI image"
                        : "Legacy/custom OCI image"}
                    </Tag>
                  ) : (
                    renderRootfsTags(activeDisplayEntry)
                  )}
                  {suggestedUpgradeEntry ? (
                    <Tag color="blue">Upgrade available</Tag>
                  ) : null}
                </Space>
                <Paragraph
                  type="secondary"
                  style={{
                    fontSize: isPage ? 16 : undefined,
                    lineHeight: isPage ? "24px" : undefined,
                    marginBottom: 8,
                  }}
                >
                  {activeDescription}
                </Paragraph>
              </div>
            </div>
          </div>

          {activeDisplayEntry?.content
            ? renderRootfsContentPanel({
                entry: activeDisplayEntry,
                onCopyToHome: async (action, targetPath) => {
                  if (!actions) return;
                  const source =
                    action.source_path?.trim() || action.path?.trim();
                  const dest = rootfsCopyTargetPath(
                    action,
                    getProjectHomeDirectory(project_id),
                    targetPath,
                  );
                  if (!source || !dest) {
                    message.error("Copy action is missing a source or target.");
                    return;
                  }
                  await actions.copyPaths({
                    src: source,
                    dest,
                    options: { force: false, errorOnExist: true },
                  });
                  return dest;
                },
                onLaunchProjectApp: async (action) => {
                  await launchRootfsProjectAppAction({
                    action,
                    project_id,
                  });
                },
                onOpenPath: (path) => {
                  void actions?.open_file({ path, foreground: true });
                },
                project_id,
              })
            : null}

          {suggestedUpgradeEntry ? (
            <Alert
              type="info"
              showIcon
              title={
                <>
                  Upgrade available:{" "}
                  <strong>
                    {displayRootfsUpgradeLabel(
                      suggestedUpgradeEntry,
                      suggestedUpgradeEntry.image,
                    )}
                  </strong>
                </>
              }
              description={
                <Space
                  direction="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  <span>
                    This keeps your current image available as the rollback
                    target.
                  </span>
                  <Space wrap size="small">
                    <Button type="primary" onClick={() => setUpgradeOpen(true)}>
                      Review upgrade
                    </Button>
                    <Button onClick={openPicker}>Other images</Button>
                  </Space>
                </Space>
              }
            />
          ) : null}

          {rootfsScanEnabled && liveRootfsScan ? (
            <Alert
              type={
                Number(liveRootfsScan.summary.severity_counts?.critical ?? 0) >
                0
                  ? "warning"
                  : liveRootfsScan.summary.status === "error"
                    ? "error"
                    : "success"
              }
              showIcon
              title="Live project image preflight scan"
              description={
                <Space
                  direction="vertical"
                  size="small"
                  style={{ width: "100%" }}
                >
                  {renderLiveRootfsScanSummary(liveRootfsScan)}
                  {renderLiveRootfsScanActions(liveRootfsScan)}
                </Space>
              }
            />
          ) : null}

          <RootfsPublishOps project_id={project_id} />

          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: isModal
                ? "repeat(auto-fit, minmax(min(340px, 100%), 1fr))"
                : "1fr",
            }}
          >
            <RuntimePanel
              icon="bolt"
              title="Actions"
              subtitle={
                isCustomRootfs
                  ? rootfsScanEnabled
                    ? "Change, scan, or publish this custom image."
                    : "Change or publish this custom image."
                  : rootfsScanEnabled
                    ? "Change, publish, scan, or manage the catalog entry."
                    : "Change, publish, or manage the catalog entry."
              }
            >
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <RuntimeAction
                  title="Change or upgrade image"
                  description={
                    isCustomRootfs
                      ? canUseCustomRootfs
                        ? "Pick a managed catalog image or replace this custom OCI image."
                        : "Pick a managed catalog image. Only admins can set arbitrary OCI images."
                      : canUseCustomRootfs
                        ? "Pick another managed catalog image or use an advanced OCI image."
                        : "Pick another managed catalog image."
                  }
                  action={
                    <Button type="primary" disabled={open} onClick={openPicker}>
                      Change
                    </Button>
                  }
                />
                <RuntimeAction
                  title="Publish current image"
                  description={
                    isCustomRootfs ? (
                      "Save catalog metadata or publish the live project image for reuse."
                    ) : (
                      <>
                        Reuse software and <code>/</code>-filesystem
                        customizations in other projects or courses.
                      </>
                    )
                  }
                  action={
                    <Button
                      disabled={open}
                      onClick={() =>
                        openPublishDialog({
                          image: activeImage,
                          entry: activeDisplayEntry,
                          publishMode: "copy",
                          copyMode: "project",
                        })
                      }
                    >
                      Publish
                    </Button>
                  }
                />
                {activeDisplayEntry?.can_manage ? (
                  <RuntimeAction
                    title="Manage catalog entry"
                    description="Update metadata, visibility, tags, version, or theme for this image."
                    action={
                      <Button
                        type="link"
                        disabled={open}
                        onClick={() =>
                          openPublishDialog({
                            image: activeImage,
                            entry: activeDisplayEntry,
                            publishMode: "manage",
                          })
                        }
                      >
                        Manage
                      </Button>
                    }
                  />
                ) : null}
                {rootfsScanEnabled ? (
                  <RuntimeAction
                    title="Scan current image"
                    description="Run a vulnerability preflight against the live project image before publishing or continuing to use it."
                    action={
                      <Button
                        disabled={open || scanningLiveRootfs}
                        loading={scanningLiveRootfs}
                        onClick={scanCurrentProjectRootfs}
                      >
                        Scan
                      </Button>
                    }
                  />
                ) : null}
              </Space>
            </RuntimePanel>

            <RuntimePanel
              icon="check-circle"
              title="Safety & lifecycle"
              subtitle="What happens when this project's image changes."
            >
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <LifecycleRow
                  label="Current"
                  value={activeLabel}
                  detail={renderRootfsStateLifecycleDetail({
                    state: currentProjectRootfsState,
                    fallback: "Active project image",
                  })}
                />
                <LifecycleRow
                  label="Rollback"
                  value={
                    previousProjectRootfsState
                      ? displayRootfsLabel(
                          previousProjectRootfsEntry,
                          previousProjectRootfsState.image,
                        )
                      : "Not available yet"
                  }
                  detail={renderRootfsStateLifecycleDetail({
                    state: previousProjectRootfsState,
                    fallback: previousProjectRootfsState
                      ? "One previous image can be restored."
                      : "After an image switch, the previous image becomes available here.",
                  })}
                  action={
                    previousProjectRootfsState ? (
                      <Button
                        danger
                        disabled={open || saving}
                        onClick={rollbackToPreviousRootfs}
                      >
                        Roll back
                      </Button>
                    ) : undefined
                  }
                />
                <LifecycleRow
                  label="Restart"
                  value={
                    restartQueuedAt
                      ? "Restart queued"
                      : projectIsRunning
                        ? "Will restart on change"
                        : "No restart needed"
                  }
                  detail={
                    restartQueuedAt
                      ? `Queued ${formatRootfsDateTime(
                          restartQueuedAt,
                        )}; the running project will restart into the selected image.`
                      : projectIsRunning
                        ? "Changing the image queues a project restart automatically."
                        : "The project is stopped; the next start uses the selected image."
                  }
                />
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  Managed image base layers do not count against project disk
                  quota. Only your writable project data counts.
                </Paragraph>
              </Space>
            </RuntimePanel>
          </div>
          <RootfsTechnicalDetails
            activeEntry={activeDisplayEntry}
            activeImage={activeImage}
            currentState={currentProjectRootfsState}
            liveRootfsScan={liveRootfsScan}
            previousEntry={previousProjectRootfsEntry}
            previousState={previousProjectRootfsState}
            project_id={project_id}
          />
        </Space>
      </div>
      {upgradeOpen && suggestedUpgradeEntry && currentDisplayEntry && (
        <Modal
          open
          width={760}
          onCancel={() => setUpgradeOpen(false)}
          onOk={applySuggestedUpgrade}
          okText={`Upgrade to ${displayRootfsUpgradeLabel(
            suggestedUpgradeEntry,
            suggestedUpgradeEntry.image,
          )}`}
          okButtonProps={{ loading: saving }}
          title={
            <>
              <Icon name="arrow-circle-up" style={{ marginRight: "12px" }} />
              Upgrade Image
            </>
          }
        >
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              title="This upgrades the visible / software environment"
              description={
                <>
                  Upgrading changes the project to a newer managed image. Your
                  files in <code>/root</code> and <code>/tmp</code> stay
                  available. Packages and files you added directly under{" "}
                  <code>/</code> belong to the previous image state and only
                  come back if you roll back.
                </>
              }
            />
            <Alert
              type="info"
              showIcon
              title="Base image size does not count against your project disk quota"
              description={
                <>
                  Managed images are shared lower directories on the host. Their
                  base size does not count against your project quota. Only your
                  own writable project data still counts.
                </>
              }
            />
            {renderRootfsEntrySummary({
              heading: "Current image",
              entry: currentDisplayEntry,
              fallbackImage:
                currentProjectRootfsState?.image ??
                value ??
                effectiveDefaultRootfs,
              note: "This is the software environment your project is using right now.",
            })}
            {renderRootfsEntrySummary({
              heading: "Upgrade target",
              entry: suggestedUpgradeEntry,
              fallbackImage: suggestedUpgradeEntry.image,
              note: "This newer image will become the visible / environment after the restart.",
            })}
            <Alert
              type="warning"
              showIcon
              title="Rollback stays available, but only for one previous image"
              description={
                previousProjectRootfsState ? (
                  <>
                    Your current image will become the new rollback target. The
                    older rollback image{" "}
                    <code>
                      {displayRootfsUpgradeLabel(
                        previousProjectRootfsEntry,
                        previousProjectRootfsState.image,
                      )}
                    </code>{" "}
                    will be replaced.
                  </>
                ) : (
                  <>
                    After the upgrade, you can still roll back to{" "}
                    <code>
                      {displayRootfsUpgradeLabel(
                        currentDisplayEntry,
                        currentProjectRootfsState?.image ??
                          value ??
                          effectiveDefaultRootfs,
                      )}
                    </code>
                    .
                  </>
                )
              }
            />
            {project.getIn(["state", "state"]) == "running" ? (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                The project is currently running, so CoCalc will restart it
                after switching the image.
              </Paragraph>
            ) : null}
          </Space>
        </Modal>
      )}
      {open && (
        <Modal
          width={920}
          open
          onCancel={() => {
            const current = getImage(rootfs, effectiveDefaultRootfs);
            setValue(current);
            setImageId(rootfs?.image_id?.trim() ?? "");
            setOpen(false);
          }}
          title={
            <>
              <Icon name="docker" style={{ marginRight: "15px" }} />
              Change / Upgrade Image{" "}
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
          okButtonProps={{
            loading: saving,
            disabled:
              rootfsMode === "catalog"
                ? !draftRootfsEntry
                : !canUseCustomRootfs || !rootfsDraft.trim(),
          }}
        >
          <Alert
            type="warning"
            showIcon
            title="Changing the image switches the visible / environment"
            description={
              <>
                Most projects should stay on their current image. Use this when
                upgrading to a newer release, rolling back, or deliberately
                moving to a different software environment. Switching back later
                restores the previous per-image <code>/</code> customizations;
                <code> /root</code> and <code>/tmp</code> remain available.
              </>
            }
            style={{ marginBottom: "12px" }}
          />
          {help && (
            <div style={{ color: "#666", marginBottom: "8px" }}>
              <p>
                Choose a managed catalog image for the normal case. Advanced
                OCI/Docker images are admin-only because they bypass CoCalc's
                catalog safety and metadata layer and can be arbitrarily large.
                You can change the image at any time.
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

          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            {rootfsMode === "catalog" &&
              currentDisplayEntry &&
              draftRootfsEntry &&
              draftRootfsEntry.id !== currentDisplayEntry.id &&
              isRelatedRootfsVersion(currentDisplayEntry, draftRootfsEntry) && (
                <Alert
                  type="info"
                  showIcon
                  title="Planned image change"
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
                      the previous image state.
                    </>
                  }
                />
              )}
            {rootfsMode === "catalog" ? (
              <>
                <div
                  style={{
                    alignItems: "center",
                    display: "grid",
                    gap: 12,
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                  }}
                >
                  <Input.Search
                    allowClear
                    disabled={rootfsLoading}
                    onChange={(e) => setRootfsSearch(e.target.value)}
                    placeholder="Search by name, image, publisher, tag, or version"
                    value={rootfsSearch}
                  />
                  <Space wrap size="small">
                    <Checkbox
                      checked={showOlderVersions}
                      onChange={(e) => setShowOlderVersions(e.target.checked)}
                    >
                      Show older versions
                    </Checkbox>
                    {canUseCustomRootfs ? (
                      <Button
                        type="link"
                        onClick={() => setRootfsMode("custom")}
                        style={{ paddingLeft: 0, width: "fit-content" }}
                      >
                        Advanced image
                      </Button>
                    ) : null}
                  </Space>
                </div>
                <div
                  style={{
                    border: `1px solid ${COLORS.GRAY_LL}`,
                    borderRadius: 12,
                    maxHeight: 430,
                    overflowY: "auto",
                    padding: 10,
                  }}
                >
                  {rootfsLoading ? (
                    <div style={{ padding: 28, textAlign: "center" }}>
                      <Spin />
                    </div>
                  ) : visiblePickerRootfsImages.length > 0 ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 10,
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(270px, 1fr))",
                      }}
                    >
                      {visiblePickerRootfsImages.map((entry) => (
                        <RootfsCatalogCard
                          key={entry.id}
                          current={
                            entry.id === currentDisplayEntry?.id ||
                            entry.image ===
                              (currentProjectRootfsState?.image ??
                                value ??
                                effectiveDefaultRootfs)
                          }
                          entry={entry}
                          onSelect={() => {
                            setRootfsDraft(entry.image);
                            setRootfsDraftId(entry.id);
                          }}
                          recommended={entry.id === suggestedUpgradeEntry?.id}
                          selected={
                            entry.id === rootfsDraftId ||
                            entry.image === rootfsDraft
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      style={{
                        color: COLORS.GRAY_M,
                        padding: 28,
                        textAlign: "center",
                      }}
                    >
                      No catalog images match this search.
                    </div>
                  )}
                </div>
                {draftRootfsEntry ? (
                  <div
                    style={{
                      background: COLORS.GRAY_LL,
                      borderRadius: 12,
                      padding: "12px 14px",
                    }}
                  >
                    <Space
                      direction="vertical"
                      size={6}
                      style={{ width: "100%" }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        Selected:{" "}
                        {displayRootfsUpgradeLabel(
                          draftRootfsEntry,
                          draftRootfsEntry.image,
                        )}
                      </div>
                      {draftRootfsEntry.description ? (
                        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                          {draftRootfsEntry.description}
                        </Paragraph>
                      ) : null}
                      <div
                        style={{
                          color: COLORS.GRAY_M,
                          fontFamily: "monospace",
                          fontSize: 11,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {draftRootfsEntry.image}
                      </div>
                      {renderRootfsEntryFacts(draftRootfsEntry)}
                      {renderRootfsContentPreview(draftRootfsEntry)}
                      {renderRootfsWarning(draftRootfsEntry)}
                      {renderRootfsScan(draftRootfsEntry)}
                    </Space>
                  </div>
                ) : null}
              </>
            ) : canUseCustomRootfs ? (
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
                      This bypasses the managed image catalog. The supported
                      path today is a glibc-based Debian or Ubuntu image, or an
                      image that already includes <code>sudo</code> and CA
                      certificates. Other package-manager bootstrap paths may
                      work, but are still experimental.
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
            ) : (
              <Alert
                type="warning"
                showIcon
                title="Advanced OCI images are admin-only"
                description="Choose a managed catalog image instead."
              />
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
          width={920}
          onCancel={() => setPublishOpen(false)}
          onOk={saveCatalogEntry}
          okText={
            publishMode === "manage"
              ? "Update Catalog Entry"
              : publishCopyMode === "project"
                ? "Publish Image"
                : "Save Metadata"
          }
          cancelText="Cancel"
          okButtonProps={{ disabled: !!publishSlugError, loading: publishing }}
          styles={{
            body: { maxHeight: "calc(100vh - 230px)", overflowY: "auto" },
          }}
          title={
            publishMode === "manage"
              ? "Manage Image Catalog Entry"
              : publishCopyMode === "project"
                ? "Publish Current Image"
                : "Save Image to My Images"
          }
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <div
              style={rootfsHeroCardStyle({
                theme:
                  rootfsThemeFromPublishDraft(publishDraft) ??
                  publishSourceEntry?.theme,
              })}
            >
              <div style={{ display: "flex", gap: 14, alignItems: "start" }}>
                {renderRootfsThemePreview({
                  ...publishSourceEntry,
                  label: publishDraft.label,
                  image: publishDraft.image,
                  theme:
                    rootfsThemeFromPublishDraft(publishDraft) ??
                    publishSourceEntry?.theme,
                })}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Space
                    wrap
                    size={[8, 6]}
                    style={{ marginBottom: 6, width: "100%" }}
                  >
                    <span
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        lineHeight: "24px",
                      }}
                    >
                      {publishDraft.label || "Untitled image"}
                    </span>
                    <Tag>
                      {publishMode === "manage"
                        ? "Update catalog entry"
                        : publishCopyMode === "project"
                          ? "Publish live image"
                          : "Save base image"}
                    </Tag>
                    <Tag color="blue">{publishDraft.visibility}</Tag>
                  </Space>
                  <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                    {publishDraft.description ||
                      (publishMode === "manage"
                        ? "Update metadata for the selected catalog entry."
                        : publishCopyMode === "project"
                          ? "Create a reusable managed image from the current visible project environment."
                          : "Save catalog metadata for the current base image string.")}
                  </Paragraph>
                  <div
                    style={{
                      color: COLORS.GRAY_M,
                      fontFamily: "monospace",
                      fontSize: 11,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {publishDraft.image}
                  </div>
                  <Button
                    href={docsPath("projects/publish-rootfs")}
                    icon={<Icon name="external-link" />}
                    size="small"
                    style={{ marginTop: 10 }}
                    target="_blank"
                  >
                    Image publishing docs
                  </Button>
                </div>
              </div>
            </div>

            <Tabs
              activeKey={publishTab}
              onChange={setPublishTab}
              items={[
                {
                  key: "publish",
                  label: "Publish",
                  children: (
                    <Space
                      direction="vertical"
                      size={16}
                      style={{ width: "100%" }}
                    >
                      <RuntimePanel
                        icon="copy"
                        title="Publish mode"
                        subtitle="Choose exactly what this action creates or updates."
                      >
                        <div
                          style={{
                            display: "grid",
                            gap: 10,
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                          }}
                        >
                          <PublishOptionCard
                            active={
                              publishMode === "copy" &&
                              publishCopyMode === "project"
                            }
                            description={
                              <>
                                Snapshot the visible <code>/</code> software
                                environment for reuse. <code>/root</code> and{" "}
                                <code>/tmp</code> are not included.
                              </>
                            }
                            onClick={() => {
                              setPublishMode("copy");
                              setPublishCopyMode("project");
                            }}
                            title="Publish live project image"
                          />
                          <PublishOptionCard
                            active={
                              publishMode === "copy" &&
                              publishCopyMode === "base"
                            }
                            description="Save metadata for the current base image string without publishing live project state."
                            onClick={() => {
                              setPublishMode("copy");
                              setPublishCopyMode("base");
                            }}
                            title="Save base image metadata"
                          />
                          {publishSourceEntry?.can_manage ? (
                            <PublishOptionCard
                              active={publishMode === "manage"}
                              description={
                                publishSourceEntry.section === "mine"
                                  ? "Update the selected catalog entry instead of creating another copy."
                                  : "Edit the selected shared or official entry instead of saving my own copy."
                              }
                              onClick={() => setPublishMode("manage")}
                              title="Update catalog entry"
                            />
                          ) : null}
                        </div>
                      </RuntimePanel>

                      {publishMode === "copy" &&
                      publishCopyMode === "project" ? (
                        <Space
                          direction="vertical"
                          size={12}
                          style={{ width: "100%" }}
                        >
                          <Checkbox
                            checked={switchPublishedProject}
                            onChange={(e) =>
                              setSwitchPublishedProject(e.target.checked)
                            }
                          >
                            Switch this project to the newly published image
                            when publishing finishes
                          </Checkbox>
                          <Alert
                            type="info"
                            showIcon
                            title="Publishing continues in the background"
                            description={
                              switchPublishedProject
                                ? "After you click Publish Image, this dialog closes and progress appears in image publish operations on the Image screen. When the publish operation succeeds, the project is switched to the new image as part of the same background operation."
                                : "After you click Publish Image, this dialog closes and progress appears in image publish operations on the Image screen. The project keeps its current image when publishing finishes."
                            }
                          />
                        </Space>
                      ) : null}
                    </Space>
                  ),
                },
                ...(rootfsScanEnabled
                  ? [
                      {
                        key: "scan",
                        label: "Scan",
                        children:
                          publishMode === "copy" &&
                          publishCopyMode === "project" ? (
                            <Alert
                              type={
                                liveRootfsScan
                                  ? Number(
                                      liveRootfsScan.summary.severity_counts
                                        ?.critical ?? 0,
                                    ) > 0
                                    ? "warning"
                                    : "success"
                                  : "info"
                              }
                              showIcon
                              title="Preflight scan the live project image before publishing"
                              description={
                                <Space
                                  direction="vertical"
                                  size="small"
                                  style={{ width: "100%" }}
                                >
                                  <div>
                                    This scans the currently mounted project
                                    image. Published images are scanned again
                                    after publication, but this check catches
                                    obvious vulnerabilities before creating the
                                    image.
                                  </div>
                                  {liveRootfsScan ? (
                                    <>
                                      {renderLiveRootfsScanSummary(
                                        liveRootfsScan,
                                      )}
                                      {renderLiveRootfsScanActions(
                                        liveRootfsScan,
                                      )}
                                    </>
                                  ) : null}
                                  <Button
                                    size="small"
                                    loading={scanningLiveRootfs}
                                    onClick={scanCurrentProjectRootfs}
                                  >
                                    Scan current image now
                                  </Button>
                                </Space>
                              }
                            />
                          ) : (
                            <Alert
                              type="info"
                              showIcon
                              message="Preflight scan is only for publishing a live project image."
                              description="Metadata-only catalog updates do not snapshot the current project filesystem, so there is no live image to scan in this dialog."
                            />
                          ),
                      },
                    ]
                  : []),
                {
                  key: "metadata",
                  label: "Metadata",
                  children: (
                    <RuntimePanel
                      icon="pencil"
                      title="Metadata"
                      subtitle="Name, describe, tag, and control who can see this image."
                    >
                      <Space
                        direction="vertical"
                        size={12}
                        style={{ width: "100%" }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gap: 12,
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
                          }}
                        >
                          <div>
                            <Paragraph strong style={{ marginBottom: 6 }}>
                              Label
                            </Paragraph>
                            <Input
                              value={publishDraft.label}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  label: e.target.value,
                                  theme: {
                                    ...cur.theme,
                                    title: e.target.value,
                                  },
                                }))
                              }
                              placeholder="e.g. Jupyter + LaTeX"
                            />
                          </div>
                          <div>
                            <Paragraph strong style={{ marginBottom: 6 }}>
                              Tags
                            </Paragraph>
                            <Select
                              mode="tags"
                              style={{ width: "100%" }}
                              options={publishTagOptions}
                              value={parseRootfsTagString(publishDraft.tags)}
                              onChange={(values) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  tags: normalizeRootfsTags(values).join(", "),
                                }))
                              }
                              tokenSeparators={[","]}
                              placeholder="course, python, jupyter, gpu"
                            />
                            <ProjectPresetTagHints
                              selectedTags={parseRootfsTagString(
                                publishDraft.tags,
                              )}
                              onAdd={(tag) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  tags: normalizeRootfsTags([
                                    ...parseRootfsTagString(cur.tags),
                                    tag,
                                  ]).join(", "),
                                }))
                              }
                            />
                          </div>
                        </div>
                        <div>
                          <Paragraph strong style={{ marginBottom: 6 }}>
                            Description
                          </Paragraph>
                          <Input.TextArea
                            value={publishDraft.description}
                            onChange={(e) =>
                              setPublishDraft((cur) => ({
                                ...cur,
                                description: e.target.value,
                                theme: {
                                  ...cur.theme,
                                  description: e.target.value,
                                },
                              }))
                            }
                            rows={3}
                            placeholder="Describe when this image should be used."
                          />
                          <Paragraph
                            type="secondary"
                            style={{ marginTop: 6, marginBottom: 0 }}
                          >
                            Plain text only. Markdown is not rendered here.
                          </Paragraph>
                        </div>
                        <div>
                          <Paragraph strong style={{ marginBottom: 6 }}>
                            Public slug
                          </Paragraph>
                          <Space.Compact style={{ width: "100%" }}>
                            <Input
                              addonBefore="/rootfs/"
                              status={publishSlugError ? "error" : undefined}
                              value={publishDraft.slug}
                              onBlur={normalizePublishSlug}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  slug: e.target.value,
                                }))
                              }
                              placeholder="auto-generated on save"
                            />
                            <Button onClick={generatePublishSlug}>
                              Generate
                            </Button>
                          </Space.Compact>
                          {publishSlugError ? (
                            <Alert
                              showIcon
                              type="error"
                              message={`Invalid slug: ${publishSlugError}`}
                              style={{ marginTop: 8 }}
                            />
                          ) : normalizedPublishSlug &&
                            normalizedPublishSlug !==
                              publishDraft.slug.trim() ? (
                            <Paragraph
                              type="secondary"
                              style={{ marginTop: 6, marginBottom: 0 }}
                            >
                              Will save as <code>{normalizedPublishSlug}</code>.
                            </Paragraph>
                          ) : (
                            <Paragraph
                              type="secondary"
                              style={{ marginTop: 6, marginBottom: 0 }}
                            >
                              Leave blank to generate one when saving or
                              publishing. Use lowercase letters, numbers, and
                              hyphens. Duplicate slugs are rejected on save.
                            </Paragraph>
                          )}
                        </div>
                        <div>
                          <Paragraph strong style={{ marginBottom: 8 }}>
                            Visibility
                          </Paragraph>
                          <div
                            style={{
                              display: "grid",
                              gap: 10,
                              gridTemplateColumns:
                                "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
                            }}
                          >
                            <PublishOptionCard
                              active={publishDraft.visibility === "private"}
                              description="Only your account can see and reuse this image."
                              onClick={() =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  visibility: "private",
                                }))
                              }
                              title="Only me"
                            />
                            <PublishOptionCard
                              active={
                                publishDraft.visibility === "collaborators"
                              }
                              description="Visible to collaborators who already share a project with you."
                              onClick={() =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  visibility: "collaborators",
                                }))
                              }
                              title="Collaborators"
                            />
                            <PublishOptionCard
                              active={publishDraft.visibility === "public"}
                              description="Visible to all site users. Use only for images you intend to share broadly."
                              onClick={() =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  visibility: "public",
                                }))
                              }
                              title="Public"
                            />
                          </div>
                        </div>
                        <div>
                          <Paragraph strong style={{ marginBottom: 8 }}>
                            Public landing page
                          </Paragraph>
                          {rootfsLandingUrl ? (
                            <Space
                              direction="vertical"
                              size={8}
                              style={{ width: "100%" }}
                            >
                              <Typography.Text
                                copyable={{ text: rootfsLandingUrl }}
                              >
                                <Typography.Link
                                  href={rootfsLandingPath}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {rootfsLandingUrl}
                                </Typography.Link>
                              </Typography.Text>
                              <Space wrap>
                                <Button
                                  href={rootfsLandingPath}
                                  icon={<Icon name="external-link" />}
                                  target="_blank"
                                >
                                  Open landing page
                                </Button>
                                <Button
                                  icon={<Icon name="copy" />}
                                  onClick={() =>
                                    void copyRootfsPublicUrl(rootfsLandingUrl)
                                  }
                                >
                                  Copy link
                                </Button>
                              </Space>
                            </Space>
                          ) : (
                            <Alert
                              type="info"
                              showIcon
                              message="Save or publish this catalog entry to create a public landing URL."
                            />
                          )}
                        </div>
                      </Space>
                    </RuntimePanel>
                  ),
                },
                {
                  key: "manifest",
                  label: "Manifest",
                  children: (
                    <Space
                      direction="vertical"
                      size={14}
                      style={{ width: "100%" }}
                    >
                      <RuntimePanel
                        icon="file-export"
                        title="Import / export config"
                        subtitle="Move portable image catalog metadata, theme, and discovery actions between images or projects."
                      >
                        <Space wrap>
                          <Button onClick={exportRootfsConfig}>
                            Export JSON
                          </Button>
                          <Button
                            onClick={() =>
                              rootfsConfigImportInputRef.current?.click()
                            }
                          >
                            Import JSON
                          </Button>
                        </Space>
                        <Space.Compact
                          style={{
                            marginTop: 10,
                            maxWidth: 720,
                            width: "100%",
                          }}
                        >
                          <Input
                            value={rootfsConfigImportProjectPath}
                            onChange={(e) =>
                              setRootfsConfigImportProjectPath(e.target.value)
                            }
                            onPressEnter={() =>
                              void importRootfsConfigProjectFile()
                            }
                            placeholder="/home/user/.cocalc/rootfs-recipes/name.rootfs-config.json"
                          />
                          <Button
                            loading={rootfsConfigImportProjectLoading}
                            onClick={() => void importRootfsConfigProjectFile()}
                          >
                            Import from project
                          </Button>
                        </Space.Compact>
                        <Paragraph
                          type="secondary"
                          style={{ marginTop: 10, marginBottom: 0 }}
                        >
                          Import updates this draft only. Save or publish to
                          update the image catalog entry.
                        </Paragraph>
                      </RuntimePanel>
                      <RootfsContentManifestBuilder
                        draft={publishContentDraft}
                        onChange={setPublishContentDraft}
                        onPickDirectory={(actionIndex, field, currentPath) =>
                          setPublishContentPicker({
                            actionIndex,
                            field,
                            pendingPath: currentPath || "/",
                          })
                        }
                        onSave={
                          publishMode === "copy" &&
                          publishCopyMode === "project"
                            ? undefined
                            : saveRootfsDiscoveryConfig
                        }
                        previewEntry={publishContentPreviewEntry}
                        project_id={project_id}
                        validation={publishContentValidation}
                      />
                    </Space>
                  ),
                },
                {
                  key: "advanced",
                  label: "Advanced",
                  children: (
                    <RuntimePanel
                      icon="settings"
                      title="Advanced publish options"
                      subtitle="Version metadata, theme, admin flags, and CLI or agent helpers."
                    >
                      <Space
                        direction="vertical"
                        size="middle"
                        style={{ width: "100%" }}
                      >
                        <div>
                          <Paragraph strong style={{ marginBottom: "6px" }}>
                            Version metadata
                          </Paragraph>
                          <Space
                            direction="vertical"
                            size="small"
                            style={{ width: "100%" }}
                          >
                            <Input
                              value={publishDraft.family}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  family: e.target.value,
                                }))
                              }
                              placeholder="Family or series, e.g. tensorflow or ubuntu"
                            />
                            {publishFamilyOptions.length > 0 ? (
                              <Space wrap size={[6, 6]}>
                                {publishFamilyOptions
                                  .slice(0, 8)
                                  .map((option) => (
                                    <Tag
                                      key={`${option.value}`}
                                      style={{ cursor: "pointer" }}
                                      onClick={() =>
                                        setPublishDraft((cur) => ({
                                          ...cur,
                                          family: `${option.value}`,
                                        }))
                                      }
                                    >
                                      {option.value}
                                    </Tag>
                                  ))}
                              </Space>
                            ) : null}
                            <Input
                              value={publishDraft.version}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  version: e.target.value,
                                }))
                              }
                              placeholder="Version, e.g. 2.4 or 24.04"
                            />
                            <Input
                              value={publishDraft.channel}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  channel: e.target.value,
                                }))
                              }
                              placeholder="Channel, e.g. stable, beta, or nightly"
                            />
                            {publishChannelOptions.length > 0 ? (
                              <Space wrap size={[6, 6]}>
                                {publishChannelOptions
                                  .slice(0, 8)
                                  .map((option) => (
                                    <Tag
                                      key={`${option.value}`}
                                      style={{ cursor: "pointer" }}
                                      onClick={() =>
                                        setPublishDraft((cur) => ({
                                          ...cur,
                                          channel: `${option.value}`,
                                        }))
                                      }
                                    >
                                      {option.value}
                                    </Tag>
                                  ))}
                              </Space>
                            ) : null}
                            <Select
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              options={publishSupersedesOptions}
                              value={
                                publishDraft.supersedes_image_id || undefined
                              }
                              onChange={(value) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  supersedes_image_id: value ?? "",
                                }))
                              }
                              placeholder="Optional image this replaces for upgrade guidance"
                            />
                            <Input
                              value={publishDraft.default_jupyter_kernel}
                              onChange={(e) =>
                                setPublishDraft((cur) => ({
                                  ...cur,
                                  default_jupyter_kernel: e.target.value,
                                }))
                              }
                              placeholder="Default notebook kernel, e.g. sagemath"
                            />
                          </Space>
                          <Paragraph
                            type="secondary"
                            style={{
                              marginTop: "6px",
                              marginBottom: 0,
                            }}
                          >
                            Optional. Use these fields for curated versioned
                            images so CoCalc can show upgrade recommendations.
                          </Paragraph>
                        </div>
                        <div>
                          <Space
                            align="start"
                            size="middle"
                            style={{
                              width: "100%",
                              justifyContent: "space-between",
                            }}
                          >
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <Paragraph
                                type="secondary"
                                style={{ marginBottom: 0 }}
                              >
                                Theme this image with a color, accent color,
                                icon, and optional artwork so it stands out in
                                image pickers.
                              </Paragraph>
                              <Space wrap style={{ marginTop: "8px" }}>
                                {publishDraft.theme.color ? (
                                  <Tag color={publishDraft.theme.color}>
                                    Color
                                  </Tag>
                                ) : null}
                                {publishDraft.theme.accent_color ? (
                                  <Tag color={publishDraft.theme.accent_color}>
                                    Accent
                                  </Tag>
                                ) : null}
                                {publishDraft.theme.image_blob?.trim() ? (
                                  <Tag>Image</Tag>
                                ) : null}
                                {publishDraft.theme.icon?.trim() ? (
                                  <Tag>{publishDraft.theme.icon.trim()}</Tag>
                                ) : null}
                              </Space>
                            </div>
                            <Button onClick={() => setPublishThemeOpen(true)}>
                              Edit theme...
                            </Button>
                          </Space>
                        </div>
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
                              Pre-pull on all hosts
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
                        <ActionAssist
                          title="Use CLI or Agent"
                          description={
                            publishMode === "copy" &&
                            publishCopyMode === "project"
                              ? "Preview the equivalent CLI command, or send the same publish request to the current workspace agent thread."
                              : "Preview the equivalent CLI command, or send the same catalog-save request to the current workspace agent thread."
                          }
                          cliTitle="RootFS CLI"
                          cliCommands={[publishAssistCommand]}
                          onSendAgent={sendPublishAssistToAgent}
                          agentDescription={
                            switchPublishedProject &&
                            publishMode === "copy" &&
                            publishCopyMode === "project"
                              ? "Agent support depends on the current workspace Codex session. This publish request also switches the project to the new image when the background operation succeeds."
                              : "Agent support depends on the current workspace Codex session."
                          }
                        />
                      </Space>
                    </RuntimePanel>
                  ),
                },
              ]}
            />

            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {publishMode === "manage"
                ? "This updates the selected catalog entry in place."
                : publishCopyMode === "project"
                  ? switchPublishedProject
                    ? "Publishing creates a new immutable managed image reference and switches this project to that image after the publish operation succeeds."
                    : "Publishing creates a new immutable managed image reference. This project keeps its current image."
                  : "This saves catalog metadata for the current image string without creating a new managed image artifact."}
            </Paragraph>
          </Space>
        </Modal>
      )}
      <input
        ref={rootfsConfigImportInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void importRootfsConfigFile(file);
          }
        }}
      />
      {rootfsConfigImportCandidate ? (
        <Modal
          open
          destroyOnHidden
          title="Import Image Config"
          okText="Import selected"
          okButtonProps={{
            disabled: !rootfsConfigImportOptionsHasSelection(
              rootfsConfigImportOptions,
            ),
          }}
          onCancel={() => setRootfsConfigImportCandidate(null)}
          onOk={applyRootfsConfigImport}
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message="Choose which parts of this JSON config to import."
              description="Import changes this draft only. Save or publish to update the image catalog metadata."
            />
            <Checkbox
              disabled={!rootfsConfigImportCandidate.metadata}
              checked={rootfsConfigImportOptions.metadata}
              onChange={(e) =>
                setRootfsConfigImportOptions((cur) => ({
                  ...cur,
                  metadata: e.target.checked,
                }))
              }
            >
              Metadata
              {rootfsConfigImportCandidate.metadata?.label
                ? `: ${rootfsConfigImportCandidate.metadata.label}`
                : ""}
            </Checkbox>
            <Checkbox
              disabled={!rootfsConfigImportCandidate.theme}
              checked={rootfsConfigImportOptions.theme}
              onChange={(e) =>
                setRootfsConfigImportOptions((cur) => ({
                  ...cur,
                  theme: e.target.checked,
                }))
              }
            >
              Theme
              {rootfsConfigImportCandidate.theme?.icon
                ? `: ${rootfsConfigImportCandidate.theme.icon}`
                : ""}
            </Checkbox>
            <Checkbox
              disabled={!rootfsConfigImportCandidate.content}
              checked={rootfsConfigImportOptions.content}
              onChange={(e) =>
                setRootfsConfigImportOptions((cur) => ({
                  ...cur,
                  content: e.target.checked,
                }))
              }
            >
              Discovery config
              {rootfsConfigImportCandidate.content
                ? `: ${(rootfsConfigImportCandidate.content.actions ?? []).length} action${(rootfsConfigImportCandidate.content.actions ?? []).length === 1 ? "" : "s"}`
                : ""}
            </Checkbox>
          </Space>
        </Modal>
      ) : null}
      {publishContentPicker && (
        <Modal
          open
          destroyOnHidden
          width={860}
          title="Choose image path"
          okText="Use this path"
          onCancel={() => setPublishContentPicker(null)}
          onOk={() => {
            const { actionIndex, field, pendingPath } = publishContentPicker;
            setPublishContentDraft((cur) => ({
              ...cur,
              actions: cur.actions.map((action, index) =>
                index === actionIndex
                  ? { ...action, [field]: pendingPath }
                  : action,
              ),
            }));
            setPublishContentPicker(null);
          }}
        >
          <DirectorySelector
            project_id={project_id}
            startingPath={publishContentPicker.pendingPath || "/"}
            onSelect={(path) =>
              setPublishContentPicker((cur) =>
                cur == null ? cur : { ...cur, pendingPath: path },
              )
            }
            style={{ width: "100%" }}
            bodyStyle={{ maxHeight: 360 }}
            closable={false}
            allowAbsolutePaths
          />
        </Modal>
      )}
      <ThemeEditorModal
        open={publishThemeOpen}
        title="Edit Image Theme"
        value={publishDraft.theme}
        onChange={(patch) =>
          setPublishDraft((cur) => ({
            ...cur,
            theme: { ...cur.theme, ...patch },
          }))
        }
        onCancel={() => setPublishThemeOpen(false)}
        onSave={() => setPublishThemeOpen(false)}
        showTitle={false}
        showDescription={false}
        defaultIcon="cube"
        projectId={project_id}
      />
    </div>
  );
}

export function RootFilesystemImageModal({
  onClose,
  open,
}: RootFilesystemImageModalProps): React.JSX.Element {
  return (
    <Modal
      destroyOnHidden
      footer={<Button onClick={onClose}>Close</Button>}
      onCancel={onClose}
      open={open}
      styles={{
        body: { maxHeight: "calc(100vh - 210px)", overflowY: "auto" },
      }}
      title={
        <>
          <Icon name="docker" style={{ marginRight: 10 }} />
          Image
        </>
      }
      width={920}
    >
      <RootFilesystemImage mode="modal" />
    </Modal>
  );
}

function getImage(
  rootfs: { image?: string | null } | null | undefined,
  fallback: string,
) {
  const image = rootfs?.image?.trim();
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

function displayRootfsUpgradeLabel(
  entry: RootfsImageEntry | undefined,
  fallbackImage: string,
): string {
  const label = displayRootfsLabel(entry, fallbackImage);
  const version = entry?.version?.trim();
  if (!version) return label;
  if (label.toLowerCase().includes(version.toLowerCase())) {
    return label;
  }
  return `${label} ${version}`;
}

function renderRootfsStateLifecycleDetail({
  fallback,
  state,
}: {
  fallback: ReactNode;
  state?: ProjectRootfsStateEntry;
}): ReactNode {
  if (!state) return fallback;
  const updated = formatRootfsDateTime(state.updated_at);
  const setBy = state.set_by_name || state.set_by_account_id;
  return (
    <span style={{ display: "block", maxWidth: "100%", minWidth: 0 }}>
      <span>
        {setBy ? `Set by ${setBy}. ` : ""}
        {updated ? `Updated ${updated}.` : ""}
      </span>
      <code
        style={{
          display: "block",
          lineHeight: 1.35,
          marginTop: 2,
          maxWidth: "100%",
          overflowWrap: "anywhere",
          whiteSpace: "normal",
          wordBreak: "break-all",
        }}
      >
        {state.image}
      </code>
    </span>
  );
}

function formatRootfsDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString();
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

function ProjectPresetTagHints({
  onAdd,
  selectedTags,
}: {
  onAdd: (tag: string) => void;
  selectedTags: string[];
}) {
  const selected = new Set(
    selectedTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
  const entries = Object.entries(ROOTFS_PROJECT_PRESET_TAGS) as Array<
    [RootfsProjectPreset, string[]]
  >;

  return (
    <div style={{ marginTop: 6 }}>
      <Paragraph type="secondary" style={{ marginBottom: 6 }}>
        Project-create presets watch these tags. Use an explicit{" "}
        <code>preset:...</code> tag when this image should be a recommended
        default.
      </Paragraph>
      <Space wrap size={[6, 6]}>
        {entries.map(([preset, tags]) => {
          const primaryTag = tags[0];
          const added = selected.has(primaryTag);
          return (
            <Button
              disabled={added}
              key={primaryTag}
              onClick={() => onAdd(primaryTag)}
              size="small"
            >
              {added ? "Added" : "Add"} {ROOTFS_PROJECT_PRESET_LABELS[preset]} (
              {primaryTag})
            </Button>
          );
        })}
      </Space>
    </div>
  );
}

function normalizeRootfsTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
}

function parseRootfsTagString(tags: string): string[] {
  return normalizeRootfsTags(tags.split(","));
}

function rootfsSlugValidationError(slug: string): string | undefined {
  try {
    validateRootfsSlug(slug);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : `${err}`;
  }
}

function rootfsNormalizedSlug(slug: string): string {
  try {
    return validateRootfsSlug(slug) ?? "";
  } catch {
    return slug;
  }
}

function rootfsValidSlug(slug: string): string | undefined {
  try {
    return validateRootfsSlug(slug);
  } catch {
    return undefined;
  }
}

function generateRootfsSlugSuggestion(
  ...parts: (string | undefined)[]
): string {
  const source = parts.find((part) => part?.trim())?.trim() ?? "rootfs";
  const base =
    source
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/--+/g, "-")
      .slice(0, 28)
      .replace(/-+$/g, "") || "rootfs";
  const suffix = Math.random().toString(36).slice(2, 8);
  return rootfsNormalizedSlug(`${base}-${suffix}`);
}

function rootfsConfigMetadataFromPublishDraft(
  draft: PublishDraft,
): RootfsConfigExportMetadata {
  return {
    label: draft.label,
    slug: draft.slug.trim() || undefined,
    description: draft.description,
    family: draft.family.trim() || undefined,
    version: draft.version.trim() || undefined,
    channel: draft.channel.trim() || undefined,
    supersedes_image_id: draft.supersedes_image_id.trim() || undefined,
    default_jupyter_kernel: draft.default_jupyter_kernel.trim() || undefined,
    visibility: draft.visibility,
    tags: parseRootfsTagString(draft.tags),
  };
}

function rootfsPublicLandingPath({
  publishDraft,
  publishSourceEntry,
}: {
  publishDraft: PublishDraft;
  publishSourceEntry?: RootfsImageEntry;
}): string | undefined {
  const slug =
    rootfsValidSlug(publishDraft.slug) || publishSourceEntry?.slug?.trim();
  if (slug) {
    return rootfsPath({ id: publishSourceEntry?.id ?? "", slug });
  }
  if (publishSourceEntry?.id) {
    return rootfsPath({ id: publishSourceEntry.id });
  }
  return undefined;
}

function absoluteRootfsPublicUrl(path?: string): string | undefined {
  if (!path) return undefined;
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

async function copyRootfsPublicUrl(url?: string): Promise<void> {
  if (!url) return;
  await navigator.clipboard.writeText(url);
  message.success("Copied image landing page link.");
}

function rootfsConfigImportOptionsFor(
  config: RootfsConfigExport,
): RootfsConfigImportOptions {
  return {
    metadata: config.metadata != null,
    theme: config.theme != null,
    content: config.content != null,
  };
}

function rootfsConfigImportOptionsHasSelection(
  options: RootfsConfigImportOptions,
): boolean {
  return options.metadata || options.theme || options.content;
}

function safeJsonFilenamePart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "rootfs-config"
  );
}

function downloadJsonFile(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function rootfsSummaryCardStyle(entry?: {
  theme?: RootfsImageTheme;
}): CSSProperties {
  const themeColor = entry?.theme?.color?.trim() || COLORS.GRAY_L;
  const accentColor = entry?.theme?.accent_color?.trim();
  return {
    border: `1px solid ${themeColor}`,
    borderRadius: 12,
    boxSizing: "border-box",
    padding: "12px 14px",
    background: accentColor ? `${accentColor}18` : "rgba(0, 0, 0, 0.02)",
    maxWidth: "760px",
    minWidth: 0,
    width: "100%",
  };
}

function renderRootfsThemePreview(
  entry?: {
    theme?: RootfsImageTheme;
    label?: string;
    image?: string;
  },
  size = 56,
): React.JSX.Element {
  return <RootfsThemePreview entry={entry} size={size} />;
}

function rootfsHeroCardStyle(entry?: {
  theme?: RootfsImageTheme;
}): CSSProperties {
  const base = rootfsSummaryCardStyle(entry);
  return {
    ...base,
    background: `linear-gradient(135deg, ${base.background}, rgba(255, 255, 255, 0.94))`,
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.06)",
    padding: "18px 20px",
  };
}

function renderRootfsTags(
  entry: RootfsImageEntry | undefined,
): React.JSX.Element | null {
  if (!entry) return null;
  return (
    <>
      {entry.section ? (
        <Tag color={sectionTagColor(entry.section)}>
          {sectionLabel(entry.section)}
        </Tag>
      ) : null}
      {entry.version ? <Tag>{entry.version}</Tag> : null}
      {entry.channel ? <Tag color="cyan">{entry.channel}</Tag> : null}
      {entry.gpu ? <Tag color="purple">GPU image</Tag> : null}
    </>
  );
}

function rootfsCatalogSearchText(entry: RootfsImageEntry): string {
  return [
    entry.label,
    entry.slug,
    entry.image,
    entry.description,
    entry.content?.title,
    entry.content?.subtitle,
    entry.content?.description,
    entry.content?.publisher?.name,
    entry.content?.license?.name,
    entry.owner_name,
    entry.family,
    entry.version,
    entry.channel,
    entry.section,
    ...(entry.content?.highlights ?? []),
    ...(entry.content?.actions ?? []).flatMap((action) => [
      action.label,
      action.description,
      action.path,
      action.source_path,
      action.target_path,
      action.url,
    ]),
    ...(entry.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function RootfsCatalogCard({
  current,
  entry,
  onSelect,
  recommended,
  selected,
}: {
  current: boolean;
  entry: RootfsImageEntry;
  onSelect: () => void;
  recommended: boolean;
  selected: boolean;
}): React.JSX.Element {
  const themeColor = entry.theme?.color?.trim() || COLORS.GRAY_L;
  const accentColor = entry.theme?.accent_color?.trim();
  const label = displayRootfsUpgradeLabel(entry, entry.image);
  const facts = [
    formatRootfsBaseSize(entry.size_gb),
    describeRootfsPublisher(entry),
  ]
    .filter(Boolean)
    .join(" • ");
  const description =
    entry.description?.trim() ||
    entry.content?.subtitle?.trim() ||
    entry.content?.description?.trim();
  const contentTitle = entry.content?.title?.trim();

  return (
    <button
      onClick={onSelect}
      style={{
        appearance: "none",
        background: selected
          ? COLORS.ANTD_BG_BLUE_L
          : accentColor
            ? `${accentColor}14`
            : "white",
        border: `1px solid ${
          selected
            ? COLORS.ANTD_LINK_BLUE
            : recommended
              ? COLORS.BG_WARNING
              : themeColor
        }`,
        borderRadius: 12,
        boxShadow: selected
          ? "0 8px 20px rgba(22, 119, 255, 0.12)"
          : "0 2px 8px rgba(0, 0, 0, 0.03)",
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        font: "inherit",
        gap: 12,
        boxSizing: "border-box",
        minHeight: 150,
        minWidth: 0,
        padding: 12,
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      {renderRootfsThemePreview(entry)}
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space wrap size={[6, 4]} style={{ marginBottom: 5, width: "100%" }}>
          {selected ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              Selected
            </Tag>
          ) : null}
          {current ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              Current
            </Tag>
          ) : null}
          {recommended ? (
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
              Recommended
            </Tag>
          ) : null}
          {renderRootfsTags(entry)}
        </Space>
        <div
          title={label}
          style={{
            fontWeight: 700,
            marginBottom: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
        {contentTitle && contentTitle !== label ? (
          <div
            title={contentTitle}
            style={{
              color: COLORS.GRAY_D,
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {contentTitle}
          </div>
        ) : null}
        {description ? (
          <div
            style={{
              color: COLORS.GRAY_D,
              display: "-webkit-box",
              fontSize: 12,
              lineHeight: "17px",
              marginBottom: 8,
              overflow: "hidden",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
            }}
          >
            {description}
          </div>
        ) : null}
        {entry.content?.highlights?.length ? (
          <Space wrap size={[4, 4]} style={{ marginTop: 6 }}>
            {entry.content.highlights.slice(0, 3).map((highlight) => (
              <Tag key={highlight} style={{ marginInlineEnd: 0 }}>
                {highlight}
              </Tag>
            ))}
          </Space>
        ) : null}
        {facts ? (
          <div
            style={{
              color: COLORS.GRAY_M,
              fontSize: 11,
              marginBottom: 6,
            }}
          >
            {facts}
          </div>
        ) : null}
        <div
          title={entry.image}
          style={{
            color: COLORS.GRAY_M,
            fontFamily: "monospace",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.image}
        </div>
      </div>
    </button>
  );
}

function PublishOptionCard({
  active,
  description,
  onClick,
  title,
}: {
  active: boolean;
  description: ReactNode;
  onClick: () => void;
  title: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        background: active ? COLORS.ANTD_BG_BLUE_L : "white",
        border: `1px solid ${active ? COLORS.ANTD_LINK_BLUE : COLORS.GRAY_LL}`,
        borderRadius: 12,
        color: "inherit",
        cursor: "pointer",
        display: "block",
        font: "inherit",
        minHeight: 104,
        padding: "12px 14px",
        textAlign: "left",
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <Tag color={active ? "blue" : "default"} style={{ marginInlineEnd: 0 }}>
          {active ? "Selected" : "Option"}
        </Tag>
        <div style={{ fontWeight: 700 }}>{title}</div>
      </div>
      <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>{description}</div>
    </button>
  );
}

function LifecycleRow({
  action,
  detail,
  label,
  value,
}: {
  action?: ReactNode;
  detail: ReactNode;
  label: ReactNode;
  value: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        alignItems: "start",
        boxSizing: "border-box",
        display: "grid",
        gap: 8,
        gridTemplateColumns: "88px minmax(0, 1fr)",
        minWidth: 0,
        width: "100%",
      }}
    >
      <Tag style={{ marginInlineEnd: 0, textAlign: "center" }}>{label}</Tag>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </div>
        <div
          style={{
            color: COLORS.GRAY_M,
            fontSize: 12,
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {detail}
        </div>
        {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
      </div>
    </div>
  );
}

function RootfsTechnicalDetails({
  activeEntry,
  activeImage,
  currentState,
  liveRootfsScan,
  previousEntry,
  previousState,
  project_id,
}: {
  activeEntry?: RootfsImageEntry;
  activeImage: string;
  currentState?: ProjectRootfsStateEntry;
  liveRootfsScan?: RootfsProjectPreflightScanResult;
  previousEntry?: RootfsImageEntry;
  previousState?: ProjectRootfsStateEntry;
  project_id: string;
}): React.JSX.Element {
  const currentImageId = currentState?.image_id ?? activeEntry?.id;
  const scanStatus = [
    activeEntry?.scan?.status ? `catalog: ${activeEntry.scan.status}` : "",
    liveRootfsScan?.summary.status
      ? `live preflight: ${liveRootfsScan.summary.status}`
      : "",
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <Collapse
      size="small"
      items={[
        {
          key: "technical",
          label: "Technical Details",
          children: (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <TechnicalGroup title="Current image state">
                <TechnicalRow
                  label="Catalog label"
                  value={
                    activeEntry
                      ? displayRootfsLabel(activeEntry, activeImage)
                      : "Custom OCI image"
                  }
                />
                <TechnicalRow
                  label="OCI image string"
                  value={<code>{currentState?.image ?? activeImage}</code>}
                />
                <TechnicalRow
                  label="Image id"
                  value={
                    currentImageId ? <code>{currentImageId}</code> : "none"
                  }
                />
                <TechnicalRow
                  label="Release id"
                  value={
                    currentState?.release_id ? (
                      <code>{currentState.release_id}</code>
                    ) : (
                      "none"
                    )
                  }
                />
                <TechnicalRow
                  label="State role"
                  value={currentState?.state_role ?? "unknown"}
                />
                <TechnicalRow
                  label="Set by"
                  value={
                    currentState?.set_by_name ||
                    currentState?.set_by_account_id ||
                    "unknown"
                  }
                />
                <TechnicalRow
                  label="Updated"
                  value={
                    formatRootfsDateTime(currentState?.updated_at) || "unknown"
                  }
                />
              </TechnicalGroup>
              <TechnicalGroup title="Previous rollback state">
                <TechnicalRow
                  label="Catalog label"
                  value={
                    previousState
                      ? displayRootfsLabel(previousEntry, previousState.image)
                      : "none"
                  }
                />
                <TechnicalRow
                  label="OCI image string"
                  value={
                    previousState?.image ? (
                      <code>{previousState.image}</code>
                    ) : (
                      "none"
                    )
                  }
                />
                <TechnicalRow
                  label="Image id"
                  value={
                    previousState?.image_id ? (
                      <code>{previousState.image_id}</code>
                    ) : (
                      "none"
                    )
                  }
                />
                <TechnicalRow
                  label="Release id"
                  value={
                    previousState?.release_id ? (
                      <code>{previousState.release_id}</code>
                    ) : (
                      "none"
                    )
                  }
                />
                <TechnicalRow
                  label="State role"
                  value={previousState?.state_role ?? "unknown"}
                />
                <TechnicalRow
                  label="Set by"
                  value={
                    previousState?.set_by_name ||
                    previousState?.set_by_account_id ||
                    "unknown"
                  }
                />
                <TechnicalRow
                  label="Updated"
                  value={
                    formatRootfsDateTime(previousState?.updated_at) || "unknown"
                  }
                />
              </TechnicalGroup>
              <TechnicalGroup title="Scan and publish operations">
                <TechnicalRow
                  label="Scan status"
                  value={scanStatus || "No scan metadata"}
                />
                {liveRootfsScan ? (
                  <TechnicalRow
                    label="Live preflight host"
                    value={<code>{liveRootfsScan.host_id}</code>}
                  />
                ) : null}
                <div style={{ gridColumn: "1 / -1" }}>
                  <RootfsPublishOps project_id={project_id} />
                </div>
              </TechnicalGroup>
            </Space>
          ),
        },
      ]}
    />
  );
}

function TechnicalGroup({
  children,
  title,
}: {
  children: ReactNode;
  title: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        boxSizing: "border-box",
        minWidth: 0,
        padding: "10px 12px",
        width: "100%",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TechnicalRow({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}): React.JSX.Element {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          color: COLORS.GRAY_M,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: COLORS.GRAY_D,
          fontSize: 12,
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function renderRootfsEntrySummary({
  heading,
  entry,
  fallbackImage,
  note,
}: {
  heading: string;
  entry: RootfsImageEntry | undefined;
  fallbackImage: string;
  note?: React.JSX.Element | string;
}): React.JSX.Element {
  return (
    <div>
      <Paragraph strong style={{ marginBottom: "8px" }}>
        {heading}
      </Paragraph>
      <div style={rootfsSummaryCardStyle(entry)}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          {renderRootfsThemePreview({
            theme: entry?.theme,
            label: entry?.label,
            image: entry?.image ?? fallbackImage,
          })}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {displayRootfsLabel(entry, fallbackImage)}
            </div>
            <Space wrap style={{ marginBottom: "6px" }}>
              {entry?.section ? (
                <Tag color={sectionTagColor(entry.section)}>
                  {sectionLabel(entry.section)}
                </Tag>
              ) : null}
              {entry?.version ? <Tag>{entry.version}</Tag> : null}
              {entry?.channel ? <Tag color="cyan">{entry.channel}</Tag> : null}
              {entry?.gpu ? <Tag color="purple">GPU image</Tag> : null}
            </Space>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: "11px",
                color: COLORS.GRAY_M,
                overflowWrap: "anywhere",
              }}
            >
              {entry?.image ?? fallbackImage}
            </div>
            {renderRootfsEntryFacts(entry)}
            {note ? (
              <Paragraph
                type="secondary"
                style={{ marginTop: "8px", marginBottom: 0 }}
              >
                {note}
              </Paragraph>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderRootfsEntryFacts(
  entry: RootfsImageEntry | undefined,
): React.JSX.Element | null {
  if (!entry) return null;
  const facts: string[] = [];
  const size = formatRootfsBaseSize(entry.size_gb);
  if (size) {
    facts.push(`Base size: ${size}`);
  }
  const publisher = describeRootfsPublisher(entry);
  if (publisher) {
    facts.push(publisher);
  }
  if (!facts.length) {
    return null;
  }
  return (
    <Paragraph type="secondary" style={{ marginTop: "8px", marginBottom: 0 }}>
      {facts.join(" • ")}
    </Paragraph>
  );
}

function renderRootfsScan(
  entry: RootfsImageEntry,
): React.JSX.Element | undefined {
  const scan = entry.scan;
  if (!scan?.status || scan.status === "unknown") {
    return;
  }
  return (
    <RootfsScanStatus
      entry={entry}
      detailsTitle={`Image scan details: ${entry.label}`}
    />
  );
}

function formatRootfsBaseSize(size_gb?: number): string | undefined {
  if (
    typeof size_gb !== "number" ||
    !Number.isFinite(size_gb) ||
    size_gb <= 0
  ) {
    return undefined;
  }
  if (size_gb >= 100) {
    return `${Math.round(size_gb)} GB`;
  }
  if (size_gb >= 10) {
    return `${size_gb.toFixed(1)} GB`;
  }
  if (size_gb >= 1) {
    return `${size_gb.toFixed(2)} GB`;
  }
  return `${Math.round(size_gb * 1000)} MB`;
}

function describeRootfsPublisher(entry: RootfsImageEntry): string | undefined {
  const owner = entry.owner_name?.trim();
  if (entry.official) {
    return owner
      ? `Official image published by ${owner}`
      : "Official CoCalc image";
  }
  if (entry.section === "mine") {
    return "Published by you";
  }
  if (entry.warning === "collaborator") {
    return owner
      ? `Published by your collaborator ${owner}`
      : "Published by one of your collaborators";
  }
  if (owner) {
    return `Published by ${owner}`;
  }
  if (entry.warning === "public") {
    return "Public community image";
  }
}

const ROOTFS_SCAN_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
] as const;

function rootfsScanReportTimestamp(
  result: RootfsProjectPreflightScanResult,
): string {
  const value = result.summary.scanned_at ?? new Date().toISOString();
  return value
    .replace(/[^0-9A-Za-z]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function markdownEscape(value: unknown): string {
  return `${value ?? ""}`.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildLiveRootfsScanMarkdown(
  result: RootfsProjectPreflightScanResult,
  jsonPath: string,
): string {
  const scan = result.summary;
  const target = scan.target;
  const counts = scan.severity_counts ?? {};
  const severityRows = ROOTFS_SCAN_SEVERITIES.map(
    (severity) => `| ${severity} | ${counts[severity] ?? 0} |`,
  ).join("\n");
  const findingRows =
    scan.highest_findings
      ?.map(
        (finding) =>
          `| ${markdownEscape(finding.id)} | ${markdownEscape(
            finding.severity,
          )} | ${markdownEscape(finding.package_name)} | ${markdownEscape(
            finding.installed_version,
          )} | ${markdownEscape(finding.fixed_version ?? "no fix listed")} | ${markdownEscape(
            finding.title,
          )} |`,
      )
      .join("\n") || "| _none reported_ |  |  |  |  |  |";

  return `# Live Project Image Preflight Scan

This report was saved from the project settings image scanner. It is a point-in-time scan of mutable project state, not the persisted official image scan.

## Summary

| Field | Value |
| --- | --- |
| Project | \`${result.project_id}\` |
| Host | \`${result.host_id}\` |
| Status | ${markdownEscape(scan.status)} |
| Policy status | ${markdownEscape(scan.policy_status ?? "")} |
| Summary | ${markdownEscape(scan.summary ?? "")} |
| Scanner | ${markdownEscape([scan.tool, scan.tool_version].filter(Boolean).join(" "))} |
| Scanned at | ${markdownEscape(scan.scanned_at ?? "")} |
| Duration | ${Math.round((result.duration_ms ?? scan.duration_ms ?? 0) / 1000)}s |
| JSON details | \`${jsonPath}\` |

## Target

| Field | Value |
| --- | --- |
| Runtime image | ${markdownEscape(target?.runtime_image ?? "")} |
| Release | ${markdownEscape(target?.release_id ?? "")} |
| Content key | ${markdownEscape(target?.content_key ?? "")} |
| Architecture | ${markdownEscape(target?.arch ?? "")} |
| Size bytes | ${markdownEscape(target?.size_bytes ?? "")} |

## Severity Counts

| Severity | Count |
| --- | ---: |
${severityRows}

## Highest Findings

| ID | Severity | Package | Installed | Fixed | Title |
| --- | --- | --- | --- | --- | --- |
${findingRows}

## Raw Report

The full JSON saved next to this file contains the retained scan summary and host scanner report metadata.
`;
}

function renderLiveRootfsScanSummary(
  result: RootfsProjectPreflightScanResult,
): React.JSX.Element {
  const counts = result.summary.severity_counts ?? {};
  const countText = [
    ["critical", counts.critical],
    ["high", counts.high],
    ["medium", counts.medium],
    ["low", counts.low],
    ["unknown", counts.unknown],
  ]
    .filter(([, count]) => Number(count ?? 0) > 0)
    .map(([severity, count]) => `${severity}: ${count}`)
    .join(", ");
  const scannedAt = result.summary.scanned_at
    ? new Date(result.summary.scanned_at).toLocaleString()
    : "just now";
  const tool = [result.summary.tool, result.summary.tool_version]
    .filter(Boolean)
    .join(" ");
  return (
    <Space orientation="vertical" size={4}>
      <div>
        {result.summary.summary ?? result.summary.status ?? "Scan complete"}
        {countText ? ` (${countText})` : ""}.
      </div>
      <div>
        Scanned live project image on host <code>{result.host_id}</code> at{" "}
        {scannedAt}
        {tool ? ` using ${tool}` : ""}. This is a point-in-time preflight scan
        of mutable project state, not the persisted official image scan.
      </div>
    </Space>
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

function rootfsEntryIsManaged(entry: RootfsImageEntry): boolean {
  return !!entry.release_id || isManagedRootfsImageName(entry.image);
}
