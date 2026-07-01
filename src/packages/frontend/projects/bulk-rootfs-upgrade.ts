/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { latestRootfsUpgradeEntry } from "@cocalc/frontend/rootfs/catalog-ui";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

export interface BulkRootfsUpgradePlanItem {
  project_id: string;
  title: string;
  state: string;
  current: RootfsImageEntry;
  next: RootfsImageEntry;
  restart: boolean;
}

export function rootfsUpgradeEntryLabel(entry: RootfsImageEntry): string {
  const label =
    entry.theme?.title?.trim() || entry.label?.trim() || entry.image;
  const version = entry.version?.trim();
  if (!version) {
    return label;
  }
  return label.toLowerCase().includes(version.toLowerCase())
    ? label
    : `${label} ${version}`;
}

export function buildBulkRootfsUpgradePlan({
  projectIds,
  projectMap,
  rootfsImages,
}: {
  projectIds: string[];
  projectMap: any;
  rootfsImages: RootfsImageEntry[];
}): BulkRootfsUpgradePlanItem[] {
  const entriesById = new Map(
    rootfsImages
      .map((entry) => [entry.id?.trim(), entry] as const)
      .filter(([id]) => !!id),
  );

  return projectIds.flatMap((project_id) => {
    const project = projectMap?.get?.(project_id);
    if (!project) {
      return [];
    }
    const rootfsImageId = `${project.get?.("rootfs_image_id") ?? ""}`.trim();
    if (!rootfsImageId) {
      return [];
    }
    const current = entriesById.get(rootfsImageId);
    if (!current) {
      return [];
    }
    const next = latestRootfsUpgradeEntry({
      current,
      images: rootfsImages,
    });
    if (!next) {
      return [];
    }
    const state = `${project.getIn?.(["state", "state"]) ?? ""}`;
    return [
      {
        project_id,
        title: `${project.get?.("title") ?? "Untitled"}`,
        state,
        current,
        next,
        restart: state === "running",
      },
    ];
  });
}
