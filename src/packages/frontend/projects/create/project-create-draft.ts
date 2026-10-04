/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  ROOTFS_PROJECT_PRESET_TAGS,
  type RootfsProjectPreset,
} from "@cocalc/frontend/rootfs/project-presets";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  type R2Region,
} from "@cocalc/util/consts";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import {
  chooseDefaultProjectImage,
  isNewProjectRootfsSelectable,
  type ProjectImageReason,
  type RecentProjectImage,
} from "../create-project-rootfs";

export type ProjectCreateMode = "standard" | "gpu" | "teaching" | "custom";

export type ProjectCreateDraft = {
  title: string;
  mode: ProjectCreateMode;
  region: R2Region;
  host_id?: string;
  rootfs_image: string;
  rootfs_image_id?: string;
  start: boolean;
  rootfs_touched: boolean;
  host_touched: boolean;
  // Why the image was chosen automatically (unset once the user picks one).
  rootfs_reason?: ProjectImageReason;
};

export type ProjectRootfsSelection = {
  image: string;
  image_id?: string;
  reason?: ProjectImageReason;
};

export type ProjectCreateContext = {
  defaultTitle: string;
  preferredRegion: R2Region;
  rootfsImages: RootfsImageEntry[];
  selectedHost?: Host;
  accountDefaultRootfs?: string;
  accountDefaultRootfsGpu?: string;
  // Your projects, most recently used by you first, with their images.
  recentProjectImages?: RecentProjectImage[];
  // The newest version of a catalog image.
  latestRootfsVersion?: (entry: RootfsImageEntry) => RootfsImageEntry;
  isAdmin?: boolean;
};

export type ProjectCreateOptions = {
  title: string;
  rootfs_image?: string;
  rootfs_image_id?: string;
  start: boolean;
  host_id?: string;
  region: R2Region;
};

export type ProjectCreateSummary = {
  title: string;
  mode: ProjectCreateMode;
  region: R2Region;
  start: boolean;
  rootfs_image: string;
  rootfs_image_id?: string;
  rootfsLabel: string;
  rootfsEntry?: RootfsImageEntry;
  rootfsReason?: ProjectImageReason;
  host_id?: string;
  hostName?: string;
  gpu: boolean;
  warnings: string[];
};

function clean(value: string | undefined): string {
  return `${value ?? ""}`.trim();
}

function normalizedRootfsTags(entry: RootfsImageEntry): Set<string> {
  return new Set(
    (entry.tags ?? [])
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0),
  );
}

function isRootfsProjectPreset(
  mode: ProjectCreateMode,
): mode is RootfsProjectPreset {
  return mode === "standard" || mode === "gpu" || mode === "teaching";
}

export function rootfsEntryMatchesProjectMode(
  entry: RootfsImageEntry,
  mode: ProjectCreateMode,
): boolean {
  if (!isRootfsProjectPreset(mode)) return true;
  if (mode === "gpu" && entry.gpu === true) return true;
  const tags = normalizedRootfsTags(entry);
  return ROOTFS_PROJECT_PRESET_TAGS[mode].some((tag) => tags.has(tag));
}

function selectedHostForDraft(
  draft: ProjectCreateDraft,
  context: ProjectCreateContext,
): Host | undefined {
  if (!draft.host_id || context.selectedHost?.id !== draft.host_id) {
    return undefined;
  }
  return context.selectedHost;
}

function wantsGpu(
  draft: Pick<ProjectCreateDraft, "mode" | "host_id">,
  context: ProjectCreateContext,
): boolean {
  return (
    draft.mode === "gpu" ||
    (!!draft.host_id &&
      context.selectedHost?.id === draft.host_id &&
      context.selectedHost.gpu === true)
  );
}

function defaultRootfsForDraft({
  draft,
  context,
}: {
  draft: ProjectCreateDraft;
  context: ProjectCreateContext;
}): ProjectRootfsSelection {
  const gpu = wantsGpu(draft, context);
  // The same images the picker offers for this mode.
  const images = context.rootfsImages.filter((entry) =>
    rootfsEntryMatchesProjectMode(entry, draft.mode),
  );
  const chosen = chooseDefaultProjectImage({
    images,
    isGpu: gpu,
    isAdmin: context.isAdmin,
    accountDefault: gpu
      ? clean(context.accountDefaultRootfsGpu) ||
        clean(context.accountDefaultRootfs)
      : context.accountDefaultRootfs,
    recent: context.recentProjectImages,
    latestVersion: context.latestRootfsVersion,
  });
  return {
    image: chosen?.entry.image || "",
    image_id: chosen?.entry.id,
    reason: chosen?.reason,
  };
}

function findRootfsEntry({
  image,
  image_id,
  context,
}: {
  image: string;
  image_id?: string;
  context: ProjectCreateContext;
}): RootfsImageEntry | undefined {
  const id = clean(image_id);
  if (id) {
    const byId = context.rootfsImages.find((entry) => entry.id === id);
    if (byId) return byId;
  }
  const runtimeImage = clean(image);
  if (!runtimeImage) return undefined;
  return context.rootfsImages.find((entry) => entry.image === runtimeImage);
}

function rootfsSelectionIsUsable({
  draft,
  context,
}: {
  draft: ProjectCreateDraft;
  context: ProjectCreateContext;
}): boolean {
  const image = clean(draft.rootfs_image);
  if (!image) return false;
  const entry = findRootfsEntry({
    image,
    image_id: draft.rootfs_image_id,
    context,
  });
  if (!entry) return context.isAdmin === true;
  return isNewProjectRootfsSelectable({
    entry,
    isGpu: wantsGpu(draft, context),
    isAdmin: context.isAdmin,
  });
}

export function createInitialProjectDraft(
  context: ProjectCreateContext,
): ProjectCreateDraft {
  const draft: ProjectCreateDraft = {
    title: context.defaultTitle,
    mode: "standard",
    region: context.preferredRegion || DEFAULT_R2_REGION,
    start: true,
    rootfs_image: DEFAULT_PROJECT_IMAGE,
    rootfs_touched: false,
    host_touched: false,
  };
  return normalizeProjectDraft(draft, context);
}

export function normalizeProjectDraft(
  draft: ProjectCreateDraft,
  context: ProjectCreateContext,
): ProjectCreateDraft {
  let next: ProjectCreateDraft = {
    ...draft,
    region: draft.region || context.preferredRegion || DEFAULT_R2_REGION,
  };

  const selectedHost = selectedHostForDraft(next, context);
  if (selectedHost) {
    const hostRegion = mapCloudRegionToR2Region(selectedHost.region);
    if (hostRegion && hostRegion !== next.region) {
      next = { ...next, host_id: undefined };
    }
  }

  if (
    !next.rootfs_touched ||
    !rootfsSelectionIsUsable({ draft: next, context })
  ) {
    const rootfs = defaultRootfsForDraft({ draft: next, context });
    next = {
      ...next,
      rootfs_image: rootfs.image,
      rootfs_image_id: rootfs.image_id,
      rootfs_reason: rootfs.reason,
    };
  }

  return next;
}

export function applyProjectPreset(
  draft: ProjectCreateDraft,
  mode: ProjectCreateMode,
  context: ProjectCreateContext,
): ProjectCreateDraft {
  const selectedHost = selectedHostForDraft(draft, context);
  return normalizeProjectDraft(
    {
      ...draft,
      mode,
      host_id:
        mode === "gpu" && selectedHost?.gpu !== true
          ? undefined
          : draft.host_id,
      rootfs_touched: false,
    },
    context,
  );
}

export function setProjectDraftTitle(
  draft: ProjectCreateDraft,
  title: string,
): ProjectCreateDraft {
  return { ...draft, title };
}

export function setProjectDraftRegion(
  draft: ProjectCreateDraft,
  region: R2Region,
  context: ProjectCreateContext,
): ProjectCreateDraft {
  return normalizeProjectDraft({ ...draft, region }, context);
}

export function setProjectDraftHost(
  draft: ProjectCreateDraft,
  host: Host | undefined,
  context: ProjectCreateContext,
): ProjectCreateDraft {
  const hostRegion = host ? mapCloudRegionToR2Region(host.region) : undefined;
  return normalizeProjectDraft(
    {
      ...draft,
      host_id: host?.id,
      region: hostRegion ?? draft.region,
      host_touched: true,
    },
    { ...context, selectedHost: host },
  );
}

export function setProjectDraftRootfs(
  draft: ProjectCreateDraft,
  rootfs: ProjectRootfsSelection,
  context: ProjectCreateContext,
): ProjectCreateDraft {
  return normalizeProjectDraft(
    {
      ...draft,
      rootfs_image: clean(rootfs.image),
      rootfs_image_id: clean(rootfs.image_id) || undefined,
      rootfs_touched: true,
      rootfs_reason: undefined,
    },
    context,
  );
}

export function setProjectDraftStart(
  draft: ProjectCreateDraft,
  start: boolean,
): ProjectCreateDraft {
  return { ...draft, start };
}

export function projectDraftToCreateOptions(
  draft: ProjectCreateDraft,
): ProjectCreateOptions {
  const rootfs_image = clean(draft.rootfs_image);
  const rootfs_image_id = clean(draft.rootfs_image_id);
  const host_id = clean(draft.host_id);
  return {
    title: clean(draft.title),
    start: draft.start,
    region: draft.region,
    ...(rootfs_image ? { rootfs_image } : undefined),
    ...(rootfs_image_id ? { rootfs_image_id } : undefined),
    ...(host_id ? { host_id } : undefined),
  };
}

export function projectDraftSummary(
  draft: ProjectCreateDraft,
  context: ProjectCreateContext,
): ProjectCreateSummary {
  const rootfsEntry = findRootfsEntry({
    image: draft.rootfs_image,
    image_id: draft.rootfs_image_id,
    context,
  });
  const selectedHost = selectedHostForDraft(draft, context);
  const warnings: string[] = [];
  if (!clean(draft.title)) {
    warnings.push("Project title is required.");
  }
  if (!rootfsEntry && clean(draft.rootfs_image)) {
    warnings.push(
      context.isAdmin
        ? "This project uses a custom OCI image."
        : "This project is using an unavailable image; choose a managed catalog image.",
    );
  }
  if (!clean(draft.rootfs_image)) {
    warnings.push("Choose an image.");
  }
  return {
    title: draft.title,
    mode: draft.mode,
    region: draft.region,
    start: draft.start,
    rootfs_image: draft.rootfs_image,
    rootfs_image_id: draft.rootfs_image_id,
    rootfsLabel:
      rootfsEntry?.label || draft.rootfs_image || "No image selected",
    rootfsEntry,
    rootfsReason: draft.rootfs_reason,
    host_id: draft.host_id,
    hostName: selectedHost?.name,
    gpu: wantsGpu(draft, context),
    warnings,
  };
}
