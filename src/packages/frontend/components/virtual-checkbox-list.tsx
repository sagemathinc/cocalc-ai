/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef } from "react";
import { Checkbox } from "antd";
import { Virtuoso } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import { get_array_range } from "@cocalc/util/array-range";

/** A compact selector sharing the file explorer's inclusive range semantics. */
export function VirtualCheckboxList<T>({
  items,
  itemId,
  itemLabel,
  selected,
  onChange,
  disabled,
  label,
  className,
}: {
  items: T[];
  itemId: (item: T) => string;
  itemLabel: (item: T) => string;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  const anchor = useRef<string | undefined>(undefined);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const focusIndex = useRef<number | undefined>(undefined);
  function focusPendingRow() {
    if (focusIndex.current == null) return;
    const input = container.current?.querySelector<HTMLInputElement>(
      `[data-checkbox-index="${focusIndex.current}"] input`,
    );
    if (input) {
      input.focus({ preventScroll: true });
      focusIndex.current = undefined;
    }
  }
  useEffect(() => {
    // A virtual row may mount after scrolling finishes. Wait for its DOM,
    // rather than losing keyboard focus to the page when the old row unmounts.
    const observer = new MutationObserver(focusPendingRow);
    if (container.current)
      observer.observe(container.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const ids = items.map(itemId);
  const checked = new Set(selected);
  return (
    <div
      ref={container}
      role="group"
      tabIndex={-1}
      aria-label={label}
      className={className}
    >
      <Virtuoso
        ref={virtuoso}
        style={{ height: 288 }}
        data={items}
        initialItemCount={Math.min(items.length, 10)}
        computeItemKey={(_index, item) => itemId(item)}
        itemContent={(index, item) => (
          <div
            className="virtual-checkbox-list-row"
            data-checkbox-index={index}
          >
            <Checkbox
              checked={checked.has(itemId(item))}
              disabled={disabled}
              onChange={(event) => {
                const id = itemId(item);
                const range =
                  event.nativeEvent.shiftKey &&
                  anchor.current &&
                  ids.includes(anchor.current)
                    ? get_array_range(ids, anchor.current, id)
                    : [id];
                const next = new Set(selected);
                for (const key of range) {
                  if (event.target.checked) next.add(key);
                  else next.delete(key);
                }
                anchor.current = id;
                onChange([...next]);
              }}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            items.length - 1,
                            index + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        );
                // Keep browser focus outside rows being unmounted; otherwise
                // Chromium can pull the scroll back toward the old checkbox.
                container.current?.focus({ preventScroll: true });
                focusIndex.current = next;
                virtuoso.current?.scrollToIndex({
                  index: next,
                  align: "center",
                });
                focusPendingRow();
              }}
            >
              {itemLabel(item)}
            </Checkbox>
          </div>
        )}
      />
    </div>
  );
}
