/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export { DOCS_ENTRIES } from "./entries";
export {
  docsEntryVisibility,
  docsPath,
  getDocsAction,
  getDocsEntry,
  isDocsActionId,
  isDocsEntryVisible,
  listDocsActions,
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
  DocsEntry,
  DocsEntryImage,
  DocsEntryStatus,
  DocsSearchResult,
  DocsVisibility,
} from "./types";
