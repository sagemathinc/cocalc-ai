/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export { DOCS_ENTRIES } from "./entries";
export { DOCS_CHAPTERS } from "./chapters";
export {
  docsEntryVisibility,
  docsPath,
  getDocsAction,
  getDocsChapter,
  getDocsEntry,
  isDocsActionId,
  isDocsEntryVisible,
  listDocsActions,
  listDocsChapters,
  listDocsEntries,
  searchDocsEntries,
} from "./registry";
export type {
  DocsAccess,
  DocsAction,
  DocsActionId,
  DocsActionParameter,
  DocsActionParameterType,
  DocsActionSummary,
  DocsAudience,
  DocsChapter,
  DocsEntry,
  DocsEntryImage,
  DocsEntryStatus,
  DocsSearchResult,
  DocsVisibility,
} from "./types";
