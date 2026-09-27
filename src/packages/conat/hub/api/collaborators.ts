/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { authFirstRequireAccount, authFirstRequireHost } from "./util";
import type {
  CollaborationPage,
  CollaborationPerson,
  CollaborationPersonalState,
  CollaborationProject,
  CollaborationQuery,
  CollaborationResource,
  CollaborationResourceQuery,
  CollaborationResourceKind,
  CollaborationRoom,
  CollaborationSourceSnapshot,
  CollaborationTarget,
} from "@cocalc/util/collaborators";

export interface CollaboratorsApi {
  /** Bounded account-wide invalidation. Reset means discard pages and resnapshot. */
  check(opts: {
    account_id?: string;
    since?: string;
  }): Promise<{ revision: string; reset: boolean; poll_after_ms: number }>;
  listPeople(
    opts: CollaborationQuery,
  ): Promise<CollaborationPage<CollaborationPerson>>;
  listProjects(
    opts: CollaborationQuery,
  ): Promise<CollaborationPage<CollaborationProject>>;
  listResources(
    opts: CollaborationResourceQuery,
  ): Promise<CollaborationPage<CollaborationResource>>;
  /** Bounded selected-project fallback; shared-title search, no personal scopes. */
  listProjectResources(
    opts: Omit<CollaborationResourceQuery, "scope"> & { project_id: string },
  ): Promise<CollaborationPage<CollaborationResource>>;
  /** Explicit inventory request only; no file rewrite, scan or compute startup. */
  requestSource(opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
  }): Promise<{ requested: true }>;
  /** Current host only, for reconstructing monotone activity after journal loss. */
  checkpointPage(opts: {
    host_id?: string;
    project_id: string;
    chat_path: string;
    after?: string;
  }): Promise<{
    epoch: string;
    items: {
      resource_id: string;
      kind: CollaborationResourceKind;
      activity: number;
    }[];
    next?: string;
  }>;
  getResource(
    opts: CollaborationTarget & { account_id?: string },
  ): Promise<CollaborationResource | null>;
  setPersonalState(
    opts: CollaborationTarget & {
      account_id?: string;
      patch: Partial<CollaborationPersonalState>;
    },
  ): Promise<CollaborationPersonalState>;
  /** Registers metadata only; actual chat initialization uses the project data plane. */
  ensureRoom(opts: {
    project_id: string;
    account_id?: string;
    request_id: string;
  }): Promise<CollaborationRoom>;
  /** Host metadata lookup only. Rechecks hosting placement and the requesting human's membership. */
  roomForHost(opts: {
    project_id: string;
    host_id?: string;
    requesting_account_id: string;
  }): Promise<CollaborationRoom>;
  markRoomInitialized(opts: {
    project_id: string;
    host_id?: string;
    room_id: string;
    chat_path: string;
    requesting_account_id: string;
  }): Promise<CollaborationRoom & { initialized: boolean }>;
  relocateSource(opts: {
    project_id: string;
    host_id?: string;
    from_chat_path: string;
    to_chat_path: string;
    operation_id: string;
    expected_epoch: string;
    expected_destination_epoch: string | null;
  }): Promise<{ epoch: string; revision: number }>;
  registerSource(opts: {
    project_id: string;
    chat_path: string;
    host_id?: string;
    registration_id: string;
    expected_epoch: string | null;
  }): Promise<{ epoch: string }>;
  writerState(opts: {
    project_id: string;
    chat_path: string;
    host_id?: string;
  }): Promise<{
    epoch: string;
    registration_id: string | null;
    source_sequence: number;
    writer_host_id: string;
    /** Existing canonical pointer only, while enabled and assigned to this writer. */
    canonical_room?: CollaborationRoom;
  } | null>;
  sourcePage(opts: {
    project_id: string;
    host_id?: string;
    after?: string;
  }): Promise<{ paths: string[]; next?: string }>;
  ingest(opts: {
    host_id?: string;
    snapshot: CollaborationSourceSnapshot;
  }): Promise<{ revision: number; replayed: boolean }>;
}

export const collaborators = {
  check: authFirstRequireAccount,
  listPeople: authFirstRequireAccount,
  listProjects: authFirstRequireAccount,
  listResources: authFirstRequireAccount,
  listProjectResources: authFirstRequireAccount,
  requestSource: authFirstRequireAccount,
  checkpointPage: authFirstRequireHost,
  getResource: authFirstRequireAccount,
  setPersonalState: authFirstRequireAccount,
  ensureRoom: authFirstRequireAccount,
  roomForHost: authFirstRequireHost,
  markRoomInitialized: authFirstRequireHost,
  relocateSource: authFirstRequireHost,
  registerSource: authFirstRequireHost,
  writerState: authFirstRequireHost,
  sourcePage: authFirstRequireHost,
  ingest: authFirstRequireHost,
};
