/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Selecting items of a Collection for bulk actions, the same on every page
// that lists things (agents, conversations): a checkbox on each item
// (shift-click selects a range, in the order shown), a "select all" checkbox
// with the count, and a toolbar of actions for the selection.

import { Button, Checkbox } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { rangeSelection } from "./collection-selection";

export interface CollectionSelection {
  selectedIds: string[];
  isSelected: (id: string) => boolean;
  toggle: (id: string, on: boolean, shift: boolean) => void;
  setAll: (on: boolean) => void;
  clear: () => void;
  allSelected: boolean;
}

/**
 * `order`: the ids shown, in the order shown (see displayOrder), so ranges
 * and "select all" cover exactly what is visible. Selecting starts over when
 * `resetKey` changes (another tab). Ids no longer shown (a search, a scope)
 * leave the selection for good: clearing the search doesn't bring them back
 * into a later bulk action.
 */
export function useCollectionSelection({
  order,
  resetKey,
}: {
  order: string[];
  resetKey?: unknown;
}): CollectionSelection {
  const [ids, setIds] = useState<string[]>([]);
  const anchor = useRef<string | undefined>(undefined);
  useEffect(() => {
    setIds([]);
    anchor.current = undefined;
  }, [resetKey]);
  const shown = new Set(order);
  const orderKey = order.join("\n");
  useEffect(() => {
    const visible = new Set(orderKey ? orderKey.split("\n") : []);
    setIds((current) =>
      current.every((id) => visible.has(id))
        ? current
        : current.filter((id) => visible.has(id)),
    );
  }, [orderKey]);
  const selectedIds = ids.filter((id) => shown.has(id));
  const selected = new Set(selectedIds);
  return {
    selectedIds,
    isSelected: (id) => selected.has(id),
    toggle: (id, on, shift) => {
      if (shift && anchor.current != null) {
        setIds(
          rangeSelection({
            order,
            selected: selectedIds,
            anchor: anchor.current,
            id,
            on,
            selectable: () => true,
          }),
        );
      } else {
        setIds(
          on
            ? [...selectedIds.filter((x) => x !== id), id]
            : selectedIds.filter((x) => x !== id),
        );
      }
      anchor.current = id;
    },
    setAll: (on) => setIds(on ? [...order] : []),
    clear: () => setIds([]),
    allSelected: order.length > 0 && order.every((id) => selected.has(id)),
  };
}

/** One item's checkbox. */
export function SelectItemCheckbox({
  id,
  label,
  selection,
}: {
  id: string;
  label: string;
  selection: CollectionSelection;
}) {
  return (
    // Shift-click selects a range; keep it from also selecting text.
    <span
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      style={{ display: "inline-flex" }}
    >
      <Checkbox
        aria-label={label}
        checked={selection.isSelected(id)}
        onChange={(e) =>
          selection.toggle(
            id,
            e.target.checked,
            !!(e.nativeEvent as MouseEvent | undefined)?.shiftKey,
          )
        }
      />
    </span>
  );
}

/** "Select all" with the count, e.g. "38 agents · 2 selected". */
export function SelectAllCheckbox({
  label,
  count,
  selection,
}: {
  label: string;
  count: string;
  selection: CollectionSelection;
}) {
  const n = selection.selectedIds.length;
  return (
    <Checkbox
      aria-label={label}
      checked={selection.allSelected}
      indeterminate={!selection.allSelected && n > 0}
      onChange={(e) => selection.setAll(e.target.checked)}
    >
      {count}
      {n > 0 && ` · ${n} selected`}
    </Checkbox>
  );
}

/** The actions for the selection, with Clear; nothing while none is selected. */
export function SelectionToolbar({
  label,
  selection,
  children,
}: {
  label: string;
  selection: CollectionSelection;
  children: ReactNode;
}) {
  if (selection.selectedIds.length === 0) return null;
  return (
    <span
      role="toolbar"
      aria-label={label}
      style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}
    >
      {children}
      <Button size="small" type="text" onClick={selection.clear}>
        Clear
      </Button>
    </span>
  );
}
