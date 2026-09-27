/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { ComponentRef, ReactNode } from "react";
import { Button, Dropdown } from "antd";
import { Icon } from "./icon";
import { DragHandle, SortableItem, SortableList } from "./sortable-list";

export type CollectionView = "list" | "grid";
export interface CollectionMenuAction {
  key: string;
  label: string;
  onClick: () => void;
}
export interface CollectionControls {
  pinned: boolean;
  dragHandle: ReactNode;
  pinButton: ReactNode;
  orderMenu: ReactNode;
  menu: (actions: CollectionMenuAction[], label: string) => ReactNode;
}

export function CollectionViewControl({
  view,
  onChange,
  label,
}: {
  view: CollectionView;
  onChange: (view: CollectionView) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={`${label} view`}
      style={{ display: "flex", gap: 4 }}
    >
      {(["grid", "list"] as const).map((mode) => (
        <Button
          key={mode}
          type={view === mode ? "primary" : "default"}
          aria-label={`${mode === "grid" ? "Grid" : "List"} view`}
          aria-pressed={view === mode}
          icon={<Icon name={mode === "grid" ? "overview" : "list"} />}
          onClick={() => onChange(mode)}
        />
      ))}
    </div>
  );
}

/** Presentation only: identity, authorization, paging and writes belong to adapters. */
export function Collection<T>({
  items,
  itemId,
  itemTitle,
  pins,
  view,
  onPin,
  onMove,
  renderItem,
  otherTitle,
  group,
  groupTitle,
  pinLabel = itemTitle,
  busyIds = [],
}: {
  items: T[];
  itemId: (item: T) => string;
  itemTitle: (item: T) => string;
  pins: string[];
  view: CollectionView;
  onPin?: (item: T, pinned: boolean) => void;
  onMove?: (visible: string[], id: string, index: number) => void;
  renderItem: (item: T, controls: CollectionControls) => ReactNode;
  otherTitle: string;
  group?: (item: T) => string;
  groupTitle?: (id: string) => string;
  pinLabel?: (item: T) => string;
  busyIds?: string[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const focus = useRef<
    { id: string; pinned: boolean; element: HTMLElement } | undefined
  >(undefined);
  useLayoutEffect(() => {
    const pending = focus.current;
    if (!pending || pins.includes(pending.id) !== pending.pinned) return;
    focus.current = undefined;
    if (root.current?.closest("[hidden]")) return;
    if (
      document.activeElement !== document.body &&
      document.activeElement !== pending.element
    )
      return;
    Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-collection-pin]") ??
        [],
    )
      .find((element) => element.dataset.collectionPin === pending.id)
      ?.focus({ preventScroll: true });
  }, [pins]);
  const positions = new Map(pins.map((id, index) => [id, index]));
  const pinnedItems = items
    .filter((item) => positions.has(itemId(item)))
    .sort((a, b) => positions.get(itemId(a))! - positions.get(itemId(b))!);
  const others = items.filter((item) => !positions.has(itemId(item)));
  return (
    <div ref={root}>
      {[
        { key: "pinned", title: "Pinned", items: pinnedItems },
        { key: "other", title: otherTitle, items: others },
      ]
        .filter((section) => section.items.length > 0)
        .map((section) => {
          const groups = new Map<string, T[]>();
          for (const item of section.items) {
            const key = group?.(item) ?? "";
            groups.set(key, [...(groups.get(key) ?? []), item]);
          }
          const Heading = pinnedItems.length ? "h3" : "h2";
          return (
            <section key={section.key} aria-label={section.title}>
              {pinnedItems.length > 0 && (
                <h2 style={{ fontSize: 18, margin: "16px 0 8px" }}>
                  {section.title}
                </h2>
              )}
              {[...groups].map(([key, members]) => {
                const visible =
                  section.key === "pinned" ? members.map(itemId) : [];
                return (
                  <section
                    key={key}
                    aria-label={
                      group
                        ? `${section.title}: ${groupTitle?.(key) ?? key}`
                        : undefined
                    }
                  >
                    {group && (
                      <Heading style={{ fontSize: 16, margin: "16px 0 4px" }}>
                        {groupTitle?.(key) ?? key}
                      </Heading>
                    )}
                    <SortableList
                      items={visible}
                      disabled={!onMove || visible.length === 0}
                      layout={view}
                      onDragStop={(_from, to, id) => {
                        if (typeof id === "string") onMove?.(visible, id, to);
                      }}
                    >
                      <div
                        role="list"
                        style={
                          view === "grid"
                            ? {
                                display: "grid",
                                gridTemplateColumns:
                                  "repeat(auto-fill, minmax(min(100%, 190px), 1fr))",
                                gap: 8,
                              }
                            : undefined
                        }
                      >
                        {members.map((item) => {
                          const id = itemId(item);
                          const pinned = positions.has(id);
                          const title = itemTitle(item);
                          const reorder = pinned && !!onMove;
                          const row = (
                            <div role="listitem">
                              {renderItem(item, {
                                pinned,
                                dragHandle: reorder ? (
                                  <DragHandle
                                    id={id}
                                    ariaLabel={`Drag ${title} to reorder`}
                                    style={{ padding: 4, touchAction: "none" }}
                                  />
                                ) : null,
                                pinButton: onPin ? (
                                  <Button
                                    type="text"
                                    data-collection-pin={id}
                                    aria-label={`${pinned ? "Unpin" : "Pin"} ${pinLabel(item)}`}
                                    aria-pressed={pinned}
                                    aria-disabled={busyIds.includes(id)}
                                    icon={
                                      <Icon
                                        name={
                                          pinned ? "pushpin-filled" : "pushpin"
                                        }
                                      />
                                    }
                                    onClick={(event) => {
                                      if (busyIds.includes(id)) return;
                                      focus.current = {
                                        id,
                                        pinned: !pinned,
                                        element: event.currentTarget,
                                      };
                                      onPin(item, !pinned);
                                    }}
                                  />
                                ) : null,
                                orderMenu: reorder ? (
                                  <CollectionOrderMenu
                                    title={title}
                                    index={visible.indexOf(id)}
                                    count={visible.length}
                                    onMove={(index) =>
                                      onMove!(visible, id, index)
                                    }
                                  />
                                ) : null,
                                menu: (actions, label) => (
                                  <CollectionOrderMenu
                                    title={title}
                                    label={label}
                                    actions={actions}
                                    index={visible.indexOf(id)}
                                    count={visible.length}
                                    onMove={
                                      reorder
                                        ? (index) => onMove!(visible, id, index)
                                        : undefined
                                    }
                                  />
                                ),
                              })}
                            </div>
                          );
                          return reorder ? (
                            <SortableItem key={id} id={id} hideActive={false}>
                              {row}
                            </SortableItem>
                          ) : (
                            <div key={id}>{row}</div>
                          );
                        })}
                      </div>
                    </SortableList>
                  </section>
                );
              })}
            </section>
          );
        })}
    </div>
  );
}

export function CollectionOrderMenu({
  title,
  index,
  count,
  onMove,
  actions = [],
  label = `Reorder ${title}`,
}: {
  title: string;
  index: number;
  count: number;
  onMove?: (index: number) => void;
  actions?: CollectionMenuAction[];
  label?: string;
}) {
  const button = useRef<ComponentRef<typeof Button>>(null);
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      trigger={["click"]}
      getPopupContainer={(trigger) => trigger.parentElement!}
      autoFocus
      destroyOnHidden
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) button.current?.focus();
      }}
      menu={{
        items: open
          ? [
              ...actions.map(({ key, label }) => ({ key, label })),
              ...(onMove
                ? [
                    {
                      key: "collection-up",
                      label: "Move up",
                      disabled: index === 0,
                    },
                    {
                      key: "collection-down",
                      label: "Move down",
                      disabled: index === count - 1,
                    },
                  ]
                : []),
            ]
          : [],
        onClick: ({ key }) => {
          setOpen(false);
          button.current?.focus();
          if (key === "collection-up" || key === "collection-down")
            onMove?.(index + (key === "collection-up" ? -1 : 1));
          else actions.find((action) => action.key === key)?.onClick();
        },
      }}
    >
      <Button
        ref={button}
        type="text"
        aria-label={label}
        icon={<Icon name="ellipsis" />}
      />
    </Dropdown>
  );
}
