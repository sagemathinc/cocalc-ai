/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Key, ReactNode } from "react";

// react-virtuoso can call computeItemKey and itemContent with an undefined
// item while its data shrinks. Wrap both callbacks with these so a list never
// dereferences that item (it crashed e.g. the projects list with "Cannot read
// properties of undefined (reading 'project_id')"). A missing row is keyed by
// its index and renders nothing.

export function virtuosoItemKey<T>(
  key: (index: number, item: T) => Key,
): (index: number, item: T | undefined) => Key {
  return (index, item) => (item == null ? `index-${index}` : key(index, item));
}

export function virtuosoItemContent<T>(
  content: (index: number, item: T) => ReactNode,
): (index: number, item: T | undefined) => ReactNode {
  return (index, item) => (item == null ? null : content(index, item));
}
