/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The workspace sidebar's list for a page (projects, artifacts, people):
// a heading with "+ New", Pinned (drag to reorder) and Recent, and a link to
// the full page. Rows are one line: avatar, title, extras. The sidebar's
// search box above it supplies `search`, the text narrowing the list.

import { type ReactNode } from "react";
import { Button, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { DragHandle, SortableItem, SortableList } from "./sortable-list";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export interface SidebarListItem {
  id: string;
  title: string;
  avatar: ReactNode;
  // Shown after the title, e.g. a running or unread dot.
  extra?: ReactNode;
  tooltip?: string;
  current?: boolean;
  bold?: boolean;
}

interface Props {
  label: string; // "Projects"
  // Hide the label heading when a section header already names the list.
  showLabel?: boolean;
  // Just the current item (a collapsed sidebar section still shows what is
  // open, like Slack); nothing when no item is current.
  onlyCurrent?: boolean;
  itemLabel: string; // "project"
  newLabel?: string;
  onNew?: () => void;
  search: string;
  pinned: SidebarListItem[];
  recent: SidebarListItem[];
  more?: number;
  onOpen: (id: string, e?: React.MouseEvent) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onMovePin?: (visible: string[], id: string, index: number) => void;
  onAll: () => void;
  emptyText?: string;
}

export function SidebarList({
  label,
  showLabel = true,
  onlyCurrent = false,
  itemLabel,
  newLabel,
  onNew,
  search,
  pinned,
  recent,
  more = 0,
  onOpen,
  onPin,
  onMovePin,
  onAll,
  emptyText,
}: Props) {
  function row(item: SidebarListItem, isPinned: boolean) {
    return (
      <div
        role="listitem"
        className="cocalc-agent-sidebar-row"
        style={{
          display: "flex",
          alignItems: "center",
          borderRadius: 6,
          background: item.current ? UI_COLORS.selected : "transparent",
        }}
      >
        {isPinned && onMovePin && !search ? (
          <span className="cocalc-agent-sidebar-row-reveal">
            <DragHandle
              id={item.id}
              ariaLabel={`Drag ${item.title} to reorder`}
              title="Drag to reorder"
              style={{ display: "flex", padding: "10px 6px", cursor: "grab" }}
            />
          </span>
        ) : (
          <span aria-hidden style={{ flex: "0 0 26px" }} />
        )}
        <button
          type="button"
          aria-current={item.current ? "page" : undefined}
          aria-label={`Open ${itemLabel} ${item.title}`}
          title={item.tooltip ?? item.title}
          onClick={(e) => onOpen(item.id, e)}
          onAuxClick={(e) => onOpen(item.id, e)}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 0",
            border: 0,
            background: "transparent",
            color: UI_COLORS.text,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          {item.avatar}
          <Typography.Text
            ellipsis
            strong={item.current || item.bold}
            style={{ flex: 1, minWidth: 0 }}
          >
            {item.title}
          </Typography.Text>
          {item.extra}
        </button>
        {onPin && (
          <Button
            className={isPinned ? undefined : "cocalc-agent-sidebar-row-reveal"}
            type="text"
            size="small"
            aria-label={`${isPinned ? "Unpin" : "Pin"} ${item.title}`}
            aria-pressed={isPinned}
            title={isPinned ? "Unpin" : "Pin"}
            icon={
              <Icon
                name={isPinned ? "pushpin-filled" : "pushpin"}
                style={{
                  color: isPinned ? UI_COLORS.link : UI_COLORS.secondary,
                }}
              />
            }
            onClick={() => onPin(item.id, !isPinned)}
          />
        )}
      </div>
    );
  }

  const heading = (text: string) => (
    <Typography.Text type="secondary" style={{ display: "block", padding: 6 }}>
      {text}
    </Typography.Text>
  );
  const pinnedIds = pinned.map((item) => item.id);
  if (onlyCurrent) {
    const open = [...pinned, ...recent].filter((item) => item.current);
    if (open.length === 0) return null;
    return (
      <div
        role="list"
        aria-label={`Open ${itemLabel}`}
        style={{ paddingRight: 8 }}
      >
        {open.map((item) => (
          <div key={item.id}>{row(item, pinnedIds.includes(item.id))}</div>
        ))}
      </div>
    );
  }

  return (
    <section aria-label={label} style={{ paddingRight: 8 }}>
      {showLabel && (
        <Typography.Text
          type="secondary"
          style={{ display: "block", padding: "6px 0 2px" }}
        >
          {label}
        </Typography.Text>
      )}
      {onNew && (
        <Button
          block
          type="text"
          icon={<Icon name="plus" />}
          style={{ justifyContent: "flex-start", marginBottom: 6 }}
          onClick={onNew}
        >
          {newLabel}
        </Button>
      )}
      {pinned.length > 0 && (
        <>
          {heading("Pinned")}
          <div role="list" aria-label={`Pinned ${label.toLowerCase()}`}>
            <SortableList
              items={pinnedIds}
              disabled={!!search || !onMovePin}
              onDragStop={(_from, to, id) => {
                if (typeof id === "string") onMovePin?.(pinnedIds, id, to);
              }}
            >
              {pinned.map((item) => (
                <SortableItem key={item.id} id={item.id} hideActive={false}>
                  {row(item, true)}
                </SortableItem>
              ))}
            </SortableList>
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          {heading(search ? "Matches" : "Recent")}
          <div role="list" aria-label={`Recent ${label.toLowerCase()}`}>
            {recent.map((item) => (
              <div key={item.id}>{row(item, false)}</div>
            ))}
          </div>
        </>
      )}
      {pinned.length === 0 && recent.length === 0 && (
        <Typography.Paragraph type="secondary" style={{ padding: 6 }}>
          {search
            ? `No matching ${label.toLowerCase()}. Press Enter to search everything.`
            : (emptyText ?? `No ${label.toLowerCase()} yet.`)}
        </Typography.Paragraph>
      )}
      <Button type="link" size="small" onClick={onAll}>
        All {label.toLowerCase()}
        {more > 0 ? ` (${more} more)` : ""}…
      </Button>
    </section>
  );
}

// A small colored dot after a row's title (running, unread).
export function SidebarDot({ color, label }: { color: string; label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        flex: "0 0 auto",
        background: color,
      }}
    />
  );
}
