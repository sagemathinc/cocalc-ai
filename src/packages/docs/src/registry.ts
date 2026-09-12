/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DOCS_ENTRIES } from "./entries";
import { createDocsRegistry } from "./registry-core";

export const {
  docsPath,
  docsEntryVisibility,
  isDocsEntryVisible,
  listDocsEntries,
  listDocsChapters,
  getDocsChapter,
  getDocsEntry,
  isDocsActionId,
  getDocsAction,
  listDocsActions,
  searchDocsEntries,
} = createDocsRegistry(DOCS_ENTRIES);
