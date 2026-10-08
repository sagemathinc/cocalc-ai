/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createContext, forwardRef, useContext } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { Virtuoso, VirtuosoGrid } from "react-virtuoso";

export const VirtualCollectionContext = createContext<
  { scrollParent?: HTMLElement; loadMore: () => void } | undefined
>(undefined);

const GridList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function GridList({ style, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        style={{
          ...style,
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fill, minmax(min(100%, var(--collection-grid-min-width, 190px)), 1fr))",
          gap: 8,
        }}
      />
    );
  },
);
const gridComponents = { List: GridList };

export function VirtualCollectionItems<T>({
  items,
  itemId,
  renderItem,
  view = "list",
  scrollParent,
  loadMore,
}: {
  items: T[];
  itemId: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  view?: "list" | "grid";
  scrollParent?: HTMLElement;
  loadMore: () => void;
}) {
  const props = {
    data: items,
    // react-virtuoso can call these with an undefined item while the data
    // shrinks; key such a row by index instead of crashing in itemId.
    computeItemKey: (index: number, item: T | undefined) =>
      item == null ? `index-${index}` : itemId(item),
    itemContent: (_index: number, item: T | undefined) =>
      item == null ? null : renderItem(item),
    customScrollParent: scrollParent,
    useWindowScroll: !scrollParent,
    increaseViewportBy: 300,
    initialItemCount: Math.min(items.length, 10),
    endReached: loadMore,
    rangeChanged: ({ endIndex }: { endIndex: number }) => {
      // A partially filled final grid row can be visible without reaching the
      // grid's exact bottom threshold (notably at fractional browser zoom).
      if (endIndex >= items.length - 1) loadMore();
    },
  };
  return view === "grid" ? (
    <VirtuosoGrid {...props} components={gridComponents} />
  ) : (
    <Virtuoso {...props} />
  );
}

/** Reuse directory scrolling for simple lists without pin or grid controls. */
export function VirtualCollectionList<T>({
  items,
  itemId,
  renderItem,
  className,
}: {
  items: T[];
  itemId: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
}) {
  const virtual = useContext(VirtualCollectionContext);
  return (
    <div role="list" className={className}>
      {virtual ? (
        <VirtualCollectionItems
          {...virtual}
          items={items}
          itemId={itemId}
          renderItem={(item) => <div role="listitem">{renderItem(item)}</div>}
        />
      ) : (
        items.map((item) => (
          <div role="listitem" key={itemId(item)}>
            {renderItem(item)}
          </div>
        ))
      )}
    </div>
  );
}
