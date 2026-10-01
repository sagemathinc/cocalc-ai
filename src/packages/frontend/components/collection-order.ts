/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/** Preserve slots belonging to items outside the current page/filter/group. */
export function moveVisibleCollectionPin(
  pins: string[],
  visible: string[],
  id: string,
  index: number,
): string[] {
  const visibleSet = new Set(visible);
  const ordered = pins.filter((pin) => visibleSet.has(pin));
  const from = ordered.indexOf(id);
  if (
    from < 0 ||
    index < 0 ||
    index >= ordered.length ||
    !Number.isInteger(index)
  )
    return pins;
  ordered.splice(from, 1);
  ordered.splice(index, 0, id);
  let cursor = 0;
  return pins.map((pin) => (visibleSet.has(pin) ? ordered[cursor++] : pin));
}
