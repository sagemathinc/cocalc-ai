/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Element } from "./types";

export function hasCodeElements(elements?: Element[] | null): boolean {
  return elements?.some((element) => element.type === "code") ?? false;
}
