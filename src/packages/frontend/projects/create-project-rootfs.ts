import {
  isManagedRootfsImageName,
  type RootfsImageEntry,
} from "@cocalc/util/rootfs-images";

export function isNewProjectRootfsSelectable({
  entry,
  isGpu,
}: {
  entry: RootfsImageEntry;
  isGpu: boolean;
}): boolean {
  if (entry.hidden || entry.blocked) return false;
  if (!isGpu && entry.gpu === true) return false;
  return true;
}

function isManagedEntry(entry: RootfsImageEntry): boolean {
  return !!entry.release_id || isManagedRootfsImageName(entry.image);
}

export function chooseNewProjectRootfsDefault({
  images,
  isGpu,
  preferredImages,
  fallbackImage,
}: {
  images: RootfsImageEntry[];
  isGpu: boolean;
  preferredImages: Array<string | undefined>;
  fallbackImage: string;
}): RootfsImageEntry | undefined {
  const selectable = images.filter((entry) =>
    isNewProjectRootfsSelectable({ entry, isGpu }),
  );
  if (selectable.length === 0) {
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
