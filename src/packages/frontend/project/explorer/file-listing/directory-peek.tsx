/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Dropdown, Flex, Spin } from "antd";
import type { MenuProps } from "antd";
import { useMemo } from "react";
import { useIntl } from "react-intl";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { file_options } from "@cocalc/frontend/editor-tmp";
import {
  useFileDrag,
  useFolderDrop,
} from "@cocalc/frontend/project/explorer/dnd/file-dnd-provider";
import { type DirectoryListingEntry } from "@cocalc/frontend/project/explorer/types";
import { buildFileActionItems } from "@cocalc/frontend/project/file-context-menu";
import { triggerFileAction as triggerProjectFileAction } from "@cocalc/frontend/project/file-action-trigger";
import useFs from "@cocalc/frontend/project/listing/use-fs";
import useListing from "@cocalc/frontend/project/listing/use-listing";
import type { FileAction } from "@cocalc/frontend/project_actions";
import { COLORS } from "@cocalc/util/theme";
import * as misc from "@cocalc/util/misc";

interface Props {
  project_id: string;
  dirPath: string;
  onClose: () => void;
  onNavigateDirectory?: (path: string) => void;
  onOpenFile: (path: string) => void;
}

interface PeekEntry extends DirectoryListingEntry {
  fullPath: string;
}

const MAX_HEIGHT = 300;
const ITEM_WIDTH = 170;

export default function DirectoryPeek({
  project_id,
  dirPath,
  onClose,
  onNavigateDirectory,
  onOpenFile,
}: Props) {
  const intl = useIntl();
  const actions = useActions({ project_id });
  const fs = useFs({ project_id });
  const showHidden = useTypedRedux({ project_id }, "show_hidden") ?? false;
  const mask = useTypedRedux("account", "other_settings")?.get("mask_files");
  const student = useStudentProjectFunctionality(project_id);
  const { dropRef } = useFolderDrop(`explorer-peek-${dirPath}`, dirPath);
  const { listing, error } = useListing({
    fs,
    path: dirPath,
    mask,
  });

  const entries = useMemo<PeekEntry[]>(() => {
    const items = (listing ?? [])
      .filter(
        (entry) =>
          entry.name !== "." &&
          entry.name !== ".." &&
          (showHidden || !entry.name.startsWith(".")),
      )
      .map((entry) => ({
        ...entry,
        fullPath: misc.path_to_file(dirPath, entry.name),
      }));

    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return items;
  }, [listing, showHidden, dirPath]);

  function triggerFileAction(entry: PeekEntry, action: FileAction) {
    triggerProjectFileAction({
      actions,
      action,
      path: entry.fullPath,
      multiple: false,
    });
  }

  function getContextMenuItems(entry: PeekEntry): MenuProps["items"] {
    return buildFileActionItems({
      isdir: !!entry.isDir,
      intl,
      multiple: false,
      disableActions: student.disableActions,
      inSnapshots: false,
      fullPath: entry.fullPath,
      triggerFileAction: (action) => triggerFileAction(entry, action),
    });
  }

  return (
    <div
      ref={dropRef}
      style={{
        borderLeft: `5px solid ${COLORS.ANTD_LINK_BLUE}`,
        background: COLORS.BLUE_LLLL,
        padding: "8px 8px 8px 12px",
        maxHeight: MAX_HEIGHT,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 11, color: COLORS.GRAY_M }}>
          {entries.length} {misc.plural(entries.length, "item")}
        </span>
        <Button
          type="text"
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{ color: COLORS.GRAY_M }}
        >
          <Icon name="times" />
        </Button>
      </div>

      {listing == null && (
        <div style={{ textAlign: "center", padding: 12 }}>
          <Spin size="small" />
        </div>
      )}

      {error && (
        <div style={{ color: COLORS.ANTD_RED, fontSize: 12 }}>
          Error loading directory: {String(error)}
        </div>
      )}

      {listing != null && !error && entries.length === 0 && (
        <div
          style={{ color: COLORS.GRAY_M, fontSize: 12, fontStyle: "italic" }}
        >
          Empty directory
        </div>
      )}

      {entries.length > 0 && (
        <Flex wrap gap="small">
          {entries.map((entry) => (
            <PeekItem
              key={entry.fullPath}
              entry={entry}
              project_id={project_id}
              disableActions={student.disableActions}
              contextMenuItems={getContextMenuItems(entry)}
              onClick={() => {
                if (entry.isDir) {
                  if (onNavigateDirectory) {
                    onNavigateDirectory(entry.fullPath);
                  } else {
                    actions?.open_directory(entry.fullPath);
                  }
                } else {
                  onOpenFile(entry.fullPath);
                }
              }}
            />
          ))}
        </Flex>
      )}
    </div>
  );
}

function PeekItem({
  entry,
  project_id,
  disableActions,
  contextMenuItems,
  onClick,
}: {
  entry: PeekEntry;
  project_id: string;
  disableActions?: boolean;
  contextMenuItems: MenuProps["items"];
  onClick: () => void;
}) {
  const { dragRef, dragListeners, dragAttributes, isDragging } = useFileDrag(
    `peek-${entry.fullPath}`,
    [entry.fullPath],
    project_id,
  );
  const iconName = entry.isDir
    ? "folder-open"
    : (file_options(entry.name)?.icon ?? "file");

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={["contextMenu"]}>
      <Tooltip title={entry.name} mouseEnterDelay={0.5}>
        <div
          ref={dragRef}
          {...(disableActions ? {} : dragListeners)}
          {...(disableActions ? {} : dragAttributes)}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            borderRadius: 4,
            cursor: "pointer",
            width: ITEM_WIDTH,
            fontSize: 12,
            color: entry.isDir ? COLORS.ANTD_LINK_BLUE : COLORS.GRAY_D,
            opacity:
              isDragging && !disableActions ? 0.45 : entry.mask ? 0.65 : 1,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = COLORS.GRAY_LLL;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          <Icon
            name={iconName}
            style={{
              fontSize: 12,
              flexShrink: 0,
              color: entry.isDir ? COLORS.FILE_ICON : undefined,
            }}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.name}
          </span>
        </div>
      </Tooltip>
    </Dropdown>
  );
}
