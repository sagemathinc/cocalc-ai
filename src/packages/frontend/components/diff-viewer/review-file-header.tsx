/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown } from "antd";
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function reviewFileHeaderHeight(fontSize: number): number {
  return Math.max(24, Math.ceil(Math.max(13, fontSize) * 1.5)) + 13;
}

/** Single-row layout: match Pierre's itemMetrics.diffHeaderHeight exactly. */
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
  onViewBefore,
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
  onViewBefore?: () => void;
  onEditWorking?: () => void;
  workingOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const extra = [
    ...(!workingOnly && onViewBefore
      ? [
          {
            key: "before",
            label: "View before this change",
            onKeyDown: (event: KeyboardEvent) => {
              // rc-menu activates on keydown. Suppress another native Enter
              // activation after opening the modal moves focus.
              if (event.key === "Enter") event.preventDefault();
            },
            onClick: () => {
              // The menu item disappears; let the revision modal restore focus
              // to the persistent trigger instead of that detached item.
              root.current
                ?.querySelector<HTMLButtonElement>("[data-review-file-actions]")
                ?.focus({ preventScroll: true });
              onViewBefore();
            },
          },
        ]
      : []),
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
        background: UI_COLORS.inset,
        color: UI_COLORS.text,
        borderBottom: `1px solid ${UI_COLORS.border}`,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <button
        type="button"
        aria-label={`${copyLabel}: ${path}`}
        title={[
          oldPath && oldPath !== path
            ? `${oldPath} → ${path}\n${copyLabel}`
            : `${path}\n${copyLabel}`,
          description,
        ]
          .filter(Boolean)
          .join("\n")}
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
          flex: 1,
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
          flexShrink: 0,
        }}
      >
        {primary ? (
          <Button size="small" onClick={primary}>
            {workingOnly ? "Open" : "View at this revision"}
          </Button>
        ) : null}
        {extra.length ? (
          <Dropdown
            menu={{ items: extra }}
            trigger={["click"]}
            popupRender={(menu) => (
              <KeyboardBoundary boundary="git-file-actions">
                {menu}
              </KeyboardBoundary>
            )}
          >
            <Button
              size="small"
              data-review-file-actions
              aria-label={`More file actions: ${path}`}
            >
              More
            </Button>
          </Dropdown>
        ) : null}
      </div>
    </div>
  );
}
