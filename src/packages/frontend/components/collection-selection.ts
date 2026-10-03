/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Checkbox selection over a Collection (projects, agents): shift-click ranges
// follow the order the collection displays.

// The order Collection shows items in: pins (in pin order), then the rest,
// each grouped (by first appearance) when grouping is on. Shift-click
// selection ranges follow this order.
export function displayOrder(
  ids: string[],
  pins: string[],
  groupKey?: (id: string) => string,
): string[] {
  const pinPosition = new Map(pins.map((id, index) => [id, index]));
  const pinned = ids
    .filter((id) => pinPosition.has(id))
    .sort((a, b) => pinPosition.get(a)! - pinPosition.get(b)!);
  const others = ids.filter((id) => !pinPosition.has(id));
  const grouped = (section: string[]) => {
    if (!groupKey) return section;
    const groups = new Map<string, string[]>();
    for (const id of section) {
      const key = groupKey(id);
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    return [...groups.values()].flat();
  };
  return [...grouped(pinned), ...grouped(others)];
}

// Shift-click: set every selectable id between the anchor and `id` to `on`.
export function rangeSelection({
  order,
  selected,
  anchor,
  id,
  on,
  selectable,
}: {
  order: string[];
  selected: string[];
  anchor?: string;
  id: string;
  on: boolean;
  selectable: (id: string) => boolean;
}): string[] {
  const from = anchor == null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  const range =
    from < 0 || to < 0
      ? [id]
      : order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const targets = new Set(range.filter(selectable));
  targets.add(id);
  const rest = selected.filter((x) => !targets.has(x));
  return on ? [...rest, ...order.filter((x) => targets.has(x))] : rest;
}
