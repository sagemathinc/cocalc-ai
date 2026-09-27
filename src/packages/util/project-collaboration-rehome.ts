/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export const PROJECT_COLLABORATION_REHOME_VERSION = 1 as const;
export const PROJECT_COLLABORATION_REHOME_TRANSFERS =
  "project_collaboration_rehome_transfers";
export const PROJECT_COLLABORATION_REHOME_TABLES = [
  "collaboration_projects",
  "collaboration_sources",
  "collaboration_catalog",
  "collaboration_rooms",
  "collaboration_room_replacements",
  "collaboration_memberships",
  "collaboration_notification_events",
  "collaboration_notification_floors",
  "collaboration_source_requests",
  "collaboration_relocations",
  "collaboration_relation_sets",
  "collaboration_participants",
  "collaboration_references",
] as const;
export type ProjectCollaborationRehomeTable =
  (typeof PROJECT_COLLABORATION_REHOME_TABLES)[number];
export interface ProjectCollaborationRehomeOp {
  op_id: string;
  project_id: string;
  source_bay_id: string;
  dest_bay_id: string;
}
export interface ProjectCollaborationRehomeHeader extends ProjectCollaborationRehomeOp {
  version: typeof PROJECT_COLLABORATION_REHOME_VERSION;
  schema_hash: string;
}
export interface ProjectCollaborationRehomeManifest {
  pages: number;
  rows: number;
  bytes: number;
  table_rows: Record<ProjectCollaborationRehomeTable, number>;
}
export interface ProjectCollaborationRehomePage {
  version: typeof PROJECT_COLLABORATION_REHOME_VERSION;
  op_id: string;
  schema_hash: string;
  index: number;
  previous_hash: string;
  hash: string;
  table: ProjectCollaborationRehomeTable;
  rows: Record<string, unknown>[];
  table_complete: boolean;
  /** Decimal page ordinal; null only after all declared tables were exported. */
  next: string | null;
  /** Present only on the final page; covers every page including this one. */
  manifest?: ProjectCollaborationRehomeManifest;
}
export interface ProjectCollaborationRehomeAck {
  version: typeof PROJECT_COLLABORATION_REHOME_VERSION;
  op_id: string;
  schema_hash: string;
  next: string | null;
  complete: boolean;
  activated: boolean;
}
