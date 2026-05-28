/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const DOCS_PRIVATE_STATE_STORE = "cocalc-docs-private-state-v1";
export const DOCS_PRIVATE_STATE_EXPORT_KIND =
  "cocalc-docs-private-state-export-v1";

export type DocsPrivateFilter =
  | "all"
  | "starred"
  | "unstarred"
  | "learned"
  | "unlearned"
  | "notes";

export type DocsPageStateV1 = {
  version: 1;
  account_id: string;
  entry_id: string;
  slug: string;
  starred: boolean;
  starred_updated_at?: number;
  learned_at?: number;
  learned_updated_at?: number;
  last_viewed_at?: number;
  created_at: number;
  updated_at: number;
  revision: number;
};

export type DocsPageNoteV1 = {
  version: 1;
  account_id: string;
  note_id: string;
  entry_id: string;
  slug: string;
  body_md: string;
  body_hash: string;
  created_at: number;
  updated_at: number;
  deleted_at?: number;
  revision: number;
};

export type DocsPrivateStoreRecord = DocsPageStateV1 | DocsPageNoteV1;

export type DocsPrivateStateExportV1 = {
  kind: typeof DOCS_PRIVATE_STATE_EXPORT_KIND;
  version: 1;
  exported_at: number;
  pages: DocsPageStateV1[];
  notes: DocsPageNoteV1[];
};

export type DocsPrivateStateImportResult = {
  importedPages: number;
  importedNotes: number;
  skippedPages: number;
  skippedNotes: number;
  deduplicatedNotes: number;
  totalPages: number;
  totalNotes: number;
};

export type DocsPrivateStateSnapshot = {
  pages: Record<string, DocsPageStateV1>;
  notes: Record<string, DocsPageNoteV1>;
};

export type DocsPrivateEntrySummary = {
  starred: boolean;
  noteCount: number;
  noteText: string;
  learnedAt?: number;
  lastViewedAt?: number;
};
