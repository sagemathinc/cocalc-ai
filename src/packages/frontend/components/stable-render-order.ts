/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useRef } from "react";

/**
 * Keys in `previous` order, then keys new to `next` in their given order.
 *
 * Retained hidden surfaces (editor tabs, project pages) are stacked
 * absolutely, so their DOM order is not visible. Reordering keyed siblings makes
 * React move DOM nodes, and a moved node silently loses the scroll position of
 * every scroller inside it.
 */
export function stableRenderOrder(
  previous: readonly string[],
  next: Iterable<string>,
): string[] {
  const present = new Set(next);
  const order = previous.filter((key) => present.has(key));
  const kept = new Set(order);
  for (const key of present) {
    if (!kept.has(key)) order.push(key);
  }
  return order;
}

export function useStableRenderOrder(keys: Iterable<string>): string[] {
  const orderRef = useRef<string[]>([]);
  const order = stableRenderOrder(orderRef.current, keys);
  orderRef.current = order;
  return order;
}
