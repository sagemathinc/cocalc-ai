/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag, Typography } from "antd";
import { useMemo } from "react";
import type { MouseEvent } from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import {
  ProjectContext,
  type ProjectContextState,
  emptyProjectContext,
} from "@cocalc/frontend/project/context";
import { RootFilesystemImageModal } from "@cocalc/frontend/project/settings/root-filesystem-image";
import { latestRootfsUpgradeEntry } from "@cocalc/frontend/rootfs/catalog-ui";
import { COLORS } from "@cocalc/util/theme";
import { isManagedRootfsImageName } from "@cocalc/util/rootfs-images";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

const { Text } = Typography;

interface ProjectRootfsBadgeProps {
  rootfsImage?: string;
  rootfsImageId?: string;
  rootfsImages: RootfsImageEntry[];
  onClick?: (e: MouseEvent<HTMLElement>) => void;
}

interface ProjectRootfsRuntimeModalProps {
  onClose: () => void;
  open: boolean;
  project_id: string;
}

function shortRootfsImage(image: string): string {
  const value = image.trim();
  const managed = isManagedRootfsImageName(value);
  if (managed) {
    const parts = value.split("/");
    return parts[parts.length - 1] || value;
  }
  if (value.length <= 48) {
    return value;
  }
  return `${value.slice(0, 28)}...${value.slice(-12)}`;
}

export function projectRootfsEntryLabel({
  entry,
  image,
}: {
  entry?: RootfsImageEntry;
  image?: string;
}): string {
  const label = entry?.theme?.title?.trim() || entry?.label?.trim();
  const version = entry?.version?.trim();
  const base = label || shortRootfsImage(image ?? "");
  if (!version) {
    return base;
  }
  return base.toLowerCase().includes(version.toLowerCase())
    ? base
    : `${base} ${version}`;
}

function findRootfsEntry({
  image,
  imageId,
  images,
}: {
  image: string;
  imageId?: string;
  images: RootfsImageEntry[];
}): RootfsImageEntry | undefined {
  const id = imageId?.trim();
  if (id) {
    const byId = images.find((entry) => entry.id === id);
    if (byId) {
      return byId;
    }
  }
  if (!image) {
    return undefined;
  }
  return images.find((entry) => entry.image === image);
}

export function ProjectRootfsBadge({
  rootfsImage,
  rootfsImageId,
  rootfsImages,
  onClick,
}: ProjectRootfsBadgeProps) {
  const image = rootfsImage?.trim() ?? "";
  const imageId = rootfsImageId?.trim() ?? "";
  const entry = useMemo(
    () =>
      findRootfsEntry({
        image,
        imageId,
        images: rootfsImages,
      }),
    [image, imageId, rootfsImages],
  );
  const upgradeEntry = useMemo(
    () =>
      latestRootfsUpgradeEntry({
        current: entry,
        images: rootfsImages,
      }),
    [entry, rootfsImages],
  );

  const fallbackImage = image || imageId;
  if (!fallbackImage && !entry) {
    return null;
  }

  const label = projectRootfsEntryLabel({ entry, image: fallbackImage });
  const upgradeLabel = upgradeEntry
    ? projectRootfsEntryLabel({
        entry: upgradeEntry,
        image: upgradeEntry.image,
      })
    : undefined;
  const tooltip = (
    <div style={{ maxWidth: 420 }}>
      <div>
        <strong>Runtime Image:</strong> {label}
      </div>
      {entry?.image || image ? (
        <div style={{ marginTop: 4, wordBreak: "break-all" }}>
          {entry?.image || image}
        </div>
      ) : undefined}
      {upgradeLabel ? (
        <div style={{ marginTop: 6 }}>
          Upgrade available: <strong>{upgradeLabel}</strong>
        </div>
      ) : undefined}
    </div>
  );

  return (
    <Tooltip title={tooltip} placement="topLeft">
      <span
        onClick={onClick}
        style={{
          alignItems: "center",
          color: COLORS.GRAY_D,
          cursor: onClick ? "pointer" : "default",
          display: "inline-flex",
          gap: 6,
          lineHeight: 1.3,
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        <Text
          strong
          ellipsis
          style={{
            color: "inherit",
            fontSize: 12,
            maxWidth: "100%",
          }}
        >
          {label}
        </Text>
        {upgradeEntry ? (
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            Upgrade
          </Tag>
        ) : undefined}
      </span>
    </Tooltip>
  );
}

export function ProjectRootfsRuntimeModal({
  onClose,
  open,
  project_id,
}: ProjectRootfsRuntimeModalProps) {
  if (!open || !project_id) {
    return null;
  }

  return (
    <ProjectRootfsRuntimeModalContent
      onClose={onClose}
      open={open}
      project_id={project_id}
    />
  );
}

function ProjectRootfsRuntimeModalContent({
  onClose,
  open,
  project_id,
}: ProjectRootfsRuntimeModalProps) {
  const actions = useActions({ project_id });
  const project = useTypedRedux("projects", "project_map")?.get(project_id);
  const context = useMemo(
    (): ProjectContextState => ({
      ...emptyProjectContext,
      actions,
      project: project as ProjectContextState["project"],
      project_id,
    }),
    [actions, project, project_id],
  );

  return (
    <ProjectContext.Provider value={context}>
      <RootFilesystemImageModal onClose={onClose} open={open} />
    </ProjectContext.Provider>
  );
}
