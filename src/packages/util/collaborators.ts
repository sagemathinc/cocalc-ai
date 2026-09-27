/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationMessageEvent } from "./collaboration-attention";

/** Discovery metadata is never an authorization capability. */
export type CollaborationResourceKind = "conversation" | "agent" | "artifact";

export interface CollaborationTarget {
  project_id: string;
  kind: CollaborationResourceKind;
  resource_id: string;
}

export interface CollaborationPersonalState {
  alias?: string;
  collected: boolean;
  following: boolean;
  muted: boolean;
  read_through: number;
}

export interface CollaborationResource extends CollaborationTarget {
  title: string;
  project_title?: string;
  chat_path: string;
  thread_id: string;
  created_by?: string;
  participant_ids: string[];
  /** A bounded preview, not necessarily the full participation relation. */
  participant_count?: number;
  participants_truncated?: boolean;
  created_at: number;
  updated_at: number;
  /** Monotonic source activity position; metadata edits do not advance it. */
  activity: number;
  agent_id?: string;
  artifact_id?: string;
  entry_id?: string;
  archived?: boolean;
  personal?: CollaborationPersonalState;
  reason?: "mention" | "following" | "participation";
}

export interface CollaborationPerson {
  account_id: string;
  display_name: string;
  common_project_count: number;
}

export interface CollaborationProject {
  project_id: string;
  title: string;
  description: string;
  role: "owner" | "collaborator";
  last_activity_at?: number;
  /** Existing account project bookmark; never an access grant. */
  pinned?: boolean;
}

export interface CollaborationQuery {
  account_id?: string;
  project_id?: string;
  person_id?: string;
  search?: string;
  after?: string;
  limit?: number;
}

export interface CollaborationProjectQuery extends CollaborationQuery {
  /** Both views use descending project activity and keyset pagination. */
  view?: "recent" | "pinned";
}

export interface CollaborationResourceQuery extends CollaborationQuery {
  kind?: CollaborationResourceKind;
  scope?: "all" | "for-you" | "following" | "collected";
  include_archived?: boolean;
}

export interface CollaborationPage<T> {
  items: T[];
  next?: string;
  /** Account revision captured before this page; check it to detect concurrent changes. */
  revision?: string;
  coverage: "complete" | "indexing" | "partial";
  /** A bounded human-readable explanation, not a list of every missing source. */
  coverage_message?: string;
}

export interface CollaborationRoom {
  project_id: string;
  room_id: string;
  chat_path: string;
  /** Owner-persisted lifecycle guard survives host-private journal loss. */
  initialized?: boolean;
}

export interface CollaborationSourceSnapshot {
  project_id: string;
  chat_path: string;
  epoch: string;
  sequence: number;
  /** Complete replacement of one source; partial scans must not be submitted. */
  resources: CollaborationResource[];
  /** Immutable service-produced message intent, acknowledged with this snapshot. */
  notification_events?: CollaborationMessageEvent[];
  /** Resource coverage remains complete; this flags bounded relationship summaries. */
  coverage?: "complete" | "partial";
  coverage_message?: string;
}

export const COLLABORATION_PAGE_LIMIT = 50;
export const COLLABORATION_PARTICIPANT_SUMMARY_LIMIT = 64;
export const COLLABORATION_MAX_SOURCE_RESOURCES = 5000;
export const COLLABORATION_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const COLLABORATION_ROOM_PATH = "/home/user/.cocalc/collaborators.chat";

export function collaborationTargetKey(target: CollaborationTarget): string {
  return JSON.stringify([target.project_id, target.kind, target.resource_id]);
}

export function emptyCollaborationPersonalState(): CollaborationPersonalState {
  return { collected: false, following: false, muted: false, read_through: 0 };
}
