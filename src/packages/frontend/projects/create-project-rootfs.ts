import {
  isManagedRootfsImageName,
  type RootfsImageEntry,
} from "@cocalc/util/rootfs-images";
import { ROOTFS_PROJECT_PRESET_TAGS } from "@cocalc/frontend/rootfs/project-presets";

export function isNewProjectRootfsSelectable({
  entry,
  isGpu,
  isAdmin,
}: {
  entry: RootfsImageEntry;
  isGpu: boolean;
  isAdmin?: boolean;
}): boolean {
  if (entry.hidden || entry.blocked) return false;
  if (!isGpu && entry.gpu === true) return false;
  if (!isAdmin && !isManagedEntry(entry)) return false;
  return true;
}

function isManagedEntry(entry: RootfsImageEntry): boolean {
  return !!entry.release_id || isManagedRootfsImageName(entry.image);
}

// A catalog image a site admin marks as the default for people with nothing
// else to go on (new users). Only official images count, and only admins can
// set onboarding: tags.
export const ROOTFS_TAG_NEW_PROJECT_DEFAULT = "onboarding:default";

// Why an image was chosen for a new project, shown next to it.
export type ProjectImageReason =
  | { kind: "account" }
  | { kind: "recent"; project_id: string; title: string }
  | { kind: "site" }
  | { kind: "only" };

export type RecentProjectImage = {
  project_id: string;
  title: string;
  image_id?: string;
  image?: string;
};

function hasTag(entry: RootfsImageEntry, tag: string): boolean {
  return (entry.tags ?? []).some((t) => t.trim().toLowerCase() === tag);
}

function compareDefaultCandidates(
  a: RootfsImageEntry,
  b: RootfsImageEntry,
): number {
  return (
    Number(!!a.deprecated) - Number(!!b.deprecated) ||
    (b.priority ?? 0) - (a.priority ?? 0) ||
    (Date.parse(b.created ?? "") || 0) - (Date.parse(a.created ?? "") || 0) ||
    a.id.localeCompare(b.id)
  );
}

// The image a new project starts with, only from real signals, in order:
// your own default, the image of the project you used most recently, the
// site's tagged default for new users, or the only image there is. Never the
// first catalog entry or a minimal base: with no signal the user chooses.
export function chooseDefaultProjectImage({
  images,
  isGpu,
  isAdmin,
  accountDefault,
  recent = [],
  latestVersion = (entry) => entry,
}: {
  // Already limited to the images the picker offers (e.g. the project mode).
  images: RootfsImageEntry[];
  isGpu: boolean;
  isAdmin?: boolean;
  accountDefault?: string;
  // Projects ordered by when *you* last used them, most recent first.
  recent?: RecentProjectImage[];
  // The newest version of an image, so an old project does not pin an old one.
  latestVersion?: (entry: RootfsImageEntry) => RootfsImageEntry;
}): { entry: RootfsImageEntry; reason: ProjectImageReason } | undefined {
  const selectable = images.filter((entry) =>
    isNewProjectRootfsSelectable({ entry, isGpu, isAdmin }),
  );
  const managed = selectable.filter(isManagedEntry);
  // A raw OCI image (admins only) never wins over the managed catalog.
  const pool = managed.length > 0 ? managed : selectable;
  const find = (image?: string, id?: string) => {
    const wantImage = `${image ?? ""}`.trim();
    const wantId = `${id ?? ""}`.trim();
    if (!wantImage && !wantId) return undefined;
    return pool.find(
      (entry) =>
        (wantId && entry.id === wantId) ||
        (wantImage && entry.image === wantImage),
    );
  };
  const newest = (entry: RootfsImageEntry) => {
    const latest = latestVersion(entry);
    return pool.some((candidate) => candidate.id === latest.id)
      ? latest
      : entry;
  };

  const account = find(accountDefault, accountDefault);
  if (account) return { entry: account, reason: { kind: "account" } };

  for (const project of recent) {
    const entry = find(project.image, project.image_id);
    if (entry) {
      return {
        entry: newest(entry),
        reason: {
          kind: "recent",
          project_id: project.project_id,
          title: project.title,
        },
      };
    }
  }

  const site = pool
    .filter(
      (entry) =>
        entry.official === true &&
        hasTag(entry, ROOTFS_TAG_NEW_PROJECT_DEFAULT),
    )
    .sort(compareDefaultCandidates)[0];
  if (site) return { entry: site, reason: { kind: "site" } };

  if (pool.length === 1) return { entry: pool[0], reason: { kind: "only" } };
  return undefined;
}

export function describeProjectImageReason(
  reason?: ProjectImageReason,
): string | undefined {
  switch (reason?.kind) {
    case "account":
      return "your default image";
    case "recent":
      return `as in your project "${reason.title}"`;
    case "site":
      return "recommended for new projects";
    case "only":
      return undefined;
    default:
      return undefined;
  }
}

export function chooseAutomaticProjectRootfs({
  images,
  preferredImages = [],
}: {
  images: RootfsImageEntry[];
  preferredImages?: Array<string | undefined>;
}): RootfsImageEntry | undefined {
  const selectable = images.filter((entry) =>
    isNewProjectRootfsSelectable({ entry, isGpu: false, isAdmin: false }),
  );
  for (const preferredImage of preferredImages) {
    const image = preferredImage?.trim();
    if (!image) continue;
    const match = selectable.find((entry) => entry.image === image);
    if (match) return match;
  }
  const standardTags = ROOTFS_PROJECT_PRESET_TAGS.standard;
  return selectable.sort((a, b) => {
    const rank = (entry: RootfsImageEntry) => {
      const tags = (entry.tags ?? []).map((tag) => tag.trim().toLowerCase());
      const index = standardTags.findIndex((tag) => tags.includes(tag));
      return index < 0 ? standardTags.length : index;
    };
    return (
      Number(!!b.official) - Number(!!a.official) ||
      Number(!!a.deprecated) - Number(!!b.deprecated) ||
      rank(a) - rank(b) ||
      Number((a.slug || a.label).trim().toLowerCase() !== "standard") -
        Number((b.slug || b.label).trim().toLowerCase() !== "standard") ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (Date.parse(b.created ?? "") || 0) - (Date.parse(a.created ?? "") || 0) ||
      a.id.localeCompare(b.id)
    );
  })[0];
}
