/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Internal browser entrypoint: preserve the shared registry behavior while
// omitting the administrator article group that Essential Docs never displays.
import { NON_ADMIN_ENTRIES } from "./entries/non-admin";
import { orderDocsEntries } from "./entries/order";
import { createDocsRegistry } from "./registry-core";

export const { getDocsEntry, listDocsEntries, searchDocsEntries } =
  createDocsRegistry(orderDocsEntries(NON_ADMIN_ENTRIES, true));

export type { DocsAccess, DocsEntry } from "./types";
