/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown } from "antd";
import { useRef } from "react";
import { COLORS } from "@cocalc/util/theme";

export function reviewFileHeaderHeight(fontSize: number): number {
  return Math.ceil(Math.max(13, fontSize) * 1.5) + 44;
}

/** Fixed two-row layout: match Pierre's itemMetrics.diffHeaderHeight exactly. */
export function ReviewFileHeader({
  path,
  oldPath,
  fontSize,
  description,
  copyLabel = "Copy repository-relative path",
  onCopyPath,
  onCopyRelative,
  onCopyReference,
  onViewRevision,
  onEditWorking,
  workingOnly = false,
}: {
  path: string;
  oldPath?: string;
  fontSize: number;
  description?: string;
  copyLabel?: string;
  onCopyPath: () => void;
  onCopyRelative?: () => void;
  onCopyReference?: () => void;
  onViewRevision?: () => void;
  onEditWorking?: () => void;
  workingOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const extra = [
    ...(onCopyRelative
      ? [
          {
            key: "relative",
            label: "Copy repository-relative path",
            onClick: onCopyRelative,
          },
        ]
      : []),
    ...(onCopyReference
      ? [
          {
            key: "reference",
            label: "Copy review reference",
            onClick: onCopyReference,
          },
        ]
      : []),
    ...(!workingOnly && onEditWorking
      ? [
          {
            key: "edit",
            label: "Edit in this worktree",
            onClick: onEditWorking,
          },
        ]
      : []),
  ];
  const primary = workingOnly ? onEditWorking : onViewRevision;
  return (
    <div
      ref={root}
      data-review-file-header={path}
      style={{
        height: reviewFileHeaderHeight(fontSize),
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        padding: "6px 10px",
        background: COLORS.GRAY_LLL,
        color: COLORS.GRAY_D,
        borderBottom: `1px solid ${COLORS.GRAY_LL}`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <button
        type="button"
        aria-label={`${copyLabel}: ${path}`}
        title={
          oldPath && oldPath !== path
            ? `${oldPath} → ${path}\n${copyLabel}`
            : `${path}\n${copyLabel}`
        }
        style={{
          fontFamily: "monospace",
          fontSize: Math.max(13, fontSize),
          fontWeight: 700,
          lineHeight: 1.5,
          padding: 0,
          border: 0,
          background: "transparent",
          color: "inherit",
          textAlign: "left",
          whiteSpace: "nowrap",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          cursor: "copy",
          userSelect: "text",
        }}
        onClick={() => {
          const selection = root.current?.ownerDocument.getSelection();
          // Drag-selecting the filename must not immediately replace clipboard text.
          if (
            selection &&
            !selection.isCollapsed &&
            root.current?.contains(selection.anchorNode)
          )
            return;
          onCopyPath();
        }}
      >
        {path}
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          height: 24,
        }}
      >
        <span
          title={description}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {description ??
            (oldPath && oldPath !== path ? `Renamed from ${oldPath}` : "")}
        </span>
        {primary ? (
          <Button size="small" onClick={primary}>
            {workingOnly ? "Open" : "View at this revision"}
          </Button>
        ) : null}
        {extra.length ? (
          <Dropdown menu={{ items: extra }} trigger={["click"]}>
            <Button size="small" aria-label={`More file actions: ${path}`}>
              More
            </Button>
          </Dropdown>
        ) : null}
      </div>
    </div>
  );
}
