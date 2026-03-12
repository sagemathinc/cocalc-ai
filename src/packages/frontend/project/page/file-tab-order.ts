/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function reorderVisibleSubset(
  globalOrder: string[],
  visibleOrder: string[],
  activeId: string,
  overId: string,
): string[] | null {
  const oldIndex = visibleOrder.indexOf(activeId);
  const newIndex = visibleOrder.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return null;
  }

  const reorderedVisible = [...visibleOrder];
  const [moved] = reorderedVisible.splice(oldIndex, 1);
  reorderedVisible.splice(newIndex, 0, moved);

  const visibleSet = new Set(visibleOrder);
  let visibleIndex = 0;
  return globalOrder.map((path) =>
    visibleSet.has(path) ? reorderedVisible[visibleIndex++] : path,
  );
}
