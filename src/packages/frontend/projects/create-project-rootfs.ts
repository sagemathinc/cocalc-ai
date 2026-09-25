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

export function chooseNewProjectRootfsDefault({
  images,
  isGpu,
  isAdmin,
  preferredImages,
  fallbackImage,
}: {
  images: RootfsImageEntry[];
  isGpu: boolean;
  isAdmin?: boolean;
  preferredImages: Array<string | undefined>;
  fallbackImage: string;
}): RootfsImageEntry | undefined {
  const selectable = images.filter((entry) =>
    isNewProjectRootfsSelectable({ entry, isGpu, isAdmin }),
  );
  if (selectable.length !== 1) {
    return undefined;
  }

  const managedSelectable = selectable.filter(isManagedEntry);
  const hasManagedSelectable = managedSelectable.length > 0;
  for (const preferredImage of preferredImages) {
    const image = `${preferredImage ?? ""}`.trim();
    if (!image) continue;
    const candidate = selectable.find((entry) => entry.image === image);
    if (!candidate) continue;
    if (hasManagedSelectable && !isManagedEntry(candidate)) {
      continue;
    }
    return candidate;
  }

  return (
    managedSelectable.find((entry) => entry.official) ??
    managedSelectable[0] ??
    selectable.find((entry) => entry.image === fallbackImage) ??
    selectable[0]
  );
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
