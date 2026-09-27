/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { v5 as uuidv5 } from "uuid";
import type { CollaborationRoom } from "./collaborators";

export const COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES = 2048;
/** Fail closed at capacity; never evict receipts or permanent retirement fences. */
export const COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS = 32;

/** Public intent only. The authenticated subject supplies the requesting account. */
export interface CollaborationRoomReplacementRequest {
  version: 1;
  project_id: string;
  request_id: string;
  expected_room_id: string;
  expected_chat_path: string;
}

export interface CollaborationRoomReplacementState extends CollaborationRoom {
  initialized: boolean;
}

/** Current-owner service lookup; bounded retirement metadata is not a public request. */
export interface CollaborationRoomServiceState extends CollaborationRoom {
  retired_rooms?: Array<Pick<CollaborationRoom, "room_id" | "chat_path">>;
}

/**
 * Trusted inputs from current owner routing, membership and placement checks.
 * Lite supplies its sole authenticated human and its local authority identity.
 * These are not fields to copy out of the public request.
 */
export interface CollaborationRoomReplacementAuthority {
  project_id: string;
  requesting_account_id: string;
  requester_role: "owner" | "collaborator" | "none";
  authenticated_host_id: string;
  current_host_id: string | null;
  /** Service-owned project root. Hosted projects use /home/user; Lite uses its home. */
  room_home?: string;
}

/**
 * Current-host observation under source/volume lifecycle locks, not a user claim
 * or authorization token. Only a confirmed missing file permits replacement;
 * access errors, corrupt content and a mismatched marker require other recovery.
 */
export interface CollaborationRoomReplacementAbsence {
  status: "missing";
  project_id: string;
  requesting_account_id: string;
  host_id: string;
  request_id: string;
  room_id: string;
  chat_path: string;
  source_epoch: string | null;
}

/** Host-authenticated control-plane request; account identity came from its service subject. */
export interface CollaborationRoomReplacementHostRequest {
  project_id: string;
  requesting_account_id: string;
  request: CollaborationRoomReplacementRequest;
  absence?: CollaborationRoomReplacementAbsence;
}

/** Immutable owner-persisted receipt, retained for the project's lifetime. */
export interface CollaborationRoomReplacementReceipt {
  version: 1;
  operation_id: string;
  request: CollaborationRoomReplacementRequest;
  requesting_account_id: string;
  committing_host_id: string;
  room_home: string;
  previous_source_epoch: string | null;
  /** Installing a new epoch alone is insufficient: registration must stay retired. */
  retired_source_epoch: string;
  replacement: Pick<CollaborationRoom, "project_id" | "room_id" | "chat_path">;
}

export type CollaborationRoomReplacementResult =
  | {
      /** Owner initialization state only; "ready" does not prove file availability. */
      outcome: "pending" | "ready";
      operation_id: string;
      room: CollaborationRoomReplacementState;
    }
  | {
      outcome: "superseded";
      operation_id: string;
      /** Informational only; never initialize this identity or redirect old links. */
      replacement_room_id: string;
    };

export type CollaborationRoomReplacementPlan =
  | {
      action: "commit";
      expected: {
        room: CollaborationRoomReplacementState;
        source_epoch: string | null;
      };
      receipt: CollaborationRoomReplacementReceipt;
      room: CollaborationRoomReplacementState;
    }
  | { action: "return"; result: CollaborationRoomReplacementResult };

export type CollaborationRoomReplacementErrorCode =
  | "invalid_request"
  | "invalid_receipt"
  | "access_denied"
  | "stale_host"
  | "room_changed"
  | "operation_conflict"
  | "source_changed"
  | "absence_required"
  | "not_initialized"
  | "capacity_exceeded";

export class CollaborationRoomReplacementError extends Error {
  constructor(readonly code: CollaborationRoomReplacementErrorCode) {
    super(`collaboration room replacement: ${code}`);
    this.name = "CollaborationRoomReplacementError";
  }
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function fail(code: CollaborationRoomReplacementErrorCode): never {
  throw new CollaborationRoomReplacementError(code);
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail("invalid_request");
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    return fail("invalid_request");
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value))
    return fail("invalid_request");
  return value.toLowerCase();
}

function epoch(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES ||
    !value.startsWith("/") ||
    /[\u0000-\u001f\u007f\\]/.test(value) ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    new TextEncoder().encode(value).length >
      COLLABORATION_ROOM_REPLACEMENT_MAX_PATH_BYTES
  )
    return fail("invalid_request");
  return value;
}

function chatPath(value: unknown): string {
  const path = absolutePath(value);
  if (!/\.(sage-)?chat$/.test(path)) return fail("invalid_request");
  return path;
}

export function validateCollaborationRoomReplacementRequest(
  value: unknown,
): CollaborationRoomReplacementRequest {
  const input = record(value, [
    "version",
    "project_id",
    "request_id",
    "expected_room_id",
    "expected_chat_path",
  ]);
  if (input.version !== 1) return fail("invalid_request");
  return {
    version: 1,
    project_id: uuid(input.project_id),
    request_id: uuid(input.request_id),
    expected_room_id: uuid(input.expected_room_id),
    expected_chat_path: chatPath(input.expected_chat_path),
  };
}

/** Lookup key excludes placement and expected identity; the receipt binds intent. */
export function collaborationRoomReplacementOperationId(
  project_id: string,
  requesting_account_id: string,
  request_id: string,
): string {
  return uuidv5(
    JSON.stringify([
      "collaboration-room-replacement-v1",
      uuid(project_id),
      uuid(requesting_account_id),
      uuid(request_id),
    ]),
    uuidv5.URL,
  );
}

function replacementRoom(
  project_id: string,
  operation_id: string,
  room_home: string,
) {
  const room_id = uuidv5("room", operation_id);
  return {
    project_id,
    room_id,
    chat_path: chatPath(`${room_home}/.cocalc/conversations/${room_id}.chat`),
  };
}

export function validateCollaborationRoomReplacementReceipt(
  value: unknown,
): CollaborationRoomReplacementReceipt {
  try {
    const input = record(value, [
      "version",
      "operation_id",
      "request",
      "requesting_account_id",
      "committing_host_id",
      "room_home",
      "previous_source_epoch",
      "retired_source_epoch",
      "replacement",
    ]);
    if (input.version !== 1) return fail("invalid_receipt");
    const request = validateCollaborationRoomReplacementRequest(input.request);
    const requesting_account_id = uuid(input.requesting_account_id);
    const operation_id = collaborationRoomReplacementOperationId(
      request.project_id,
      requesting_account_id,
      request.request_id,
    );
    const room_home = absolutePath(input.room_home);
    if (!request.expected_chat_path.startsWith(room_home + "/"))
      return fail("invalid_receipt");
    const replacement = replacementRoom(
      request.project_id,
      operation_id,
      room_home,
    );
    const provided = record(input.replacement, [
      "project_id",
      "room_id",
      "chat_path",
    ]);
    const retired_source_epoch = uuidv5("retired-source", operation_id);
    const previous_source_epoch = epoch(input.previous_source_epoch);
    if (
      uuid(input.operation_id) !== operation_id ||
      uuid(input.retired_source_epoch) !== retired_source_epoch ||
      uuid(provided.project_id) !== replacement.project_id ||
      uuid(provided.room_id) !== replacement.room_id ||
      chatPath(provided.chat_path) !== replacement.chat_path ||
      replacement.room_id === request.expected_room_id ||
      replacement.chat_path === request.expected_chat_path ||
      previous_source_epoch === retired_source_epoch
    )
      return fail("invalid_receipt");
    return {
      version: 1,
      operation_id,
      request,
      requesting_account_id,
      committing_host_id: uuid(input.committing_host_id),
      room_home,
      previous_source_epoch,
      retired_source_epoch,
      replacement,
    };
  } catch (error) {
    if (error instanceof CollaborationRoomReplacementError)
      return fail("invalid_receipt");
    throw error;
  }
}

function roomState(value: unknown): CollaborationRoomReplacementState | null {
  if (value === null) return null;
  const input = record(value, [
    "project_id",
    "room_id",
    "chat_path",
    "initialized",
  ]);
  if (typeof input.initialized !== "boolean") return fail("invalid_request");
  return {
    project_id: uuid(input.project_id),
    room_id: uuid(input.room_id),
    chat_path: chatPath(input.chat_path),
    initialized: input.initialized,
  };
}

/**
 * Pure owner-transaction planner, not an authorization or filesystem service.
 * Resolve ownership/rehome fences and lock the project before supplying state.
 * Read the actor-bound receipt in that transaction. A commit plan requires ONE
 * atomic write of its CAS pointer, receipt, permanent old-room/source retirement,
 * catalog tombstones and revision. A changed CAS must reload/replan, not overwrite.
 * Retired sources must reject registration/recovery even after catalog compaction.
 *
 * Hold host source/volume lifecycle locks through absence observation and owner
 * commit; restore and other mediated writers must use those same locks. Only after
 * commit may the existing canonical chat service initialize the new identity,
 * with fresh pointer/lifecycle checks and no raw .chat writes or history copying.
 * An occupied destination must have the exact marker and be reused, not overwritten.
 * A ready replay still requires the normal disk/marker check, not recreation if
 * that replacement was later deleted. Old references never redirect to this room.
 * Pending replays reconcile that same initialization; superseded replays do not.
 * Receipts/fences migrate with the project and are never an access grant.
 */
export function planCollaborationRoomReplacement(input: {
  request: CollaborationRoomReplacementRequest;
  authority: CollaborationRoomReplacementAuthority;
  current_room: CollaborationRoomReplacementState | null;
  current_source_epoch: string | null;
  receipt: CollaborationRoomReplacementReceipt | null;
  absence?: CollaborationRoomReplacementAbsence;
  retained_operations: number;
}): CollaborationRoomReplacementPlan {
  const request = validateCollaborationRoomReplacementRequest(input.request);
  const authority = input.authority;
  if (
    uuid(authority.project_id) !== request.project_id ||
    authority.requester_role !== "owner"
  )
    return fail("access_denied");
  const account_id = uuid(authority.requesting_account_id);
  const host_id = uuid(authority.authenticated_host_id);
  if (
    authority.current_host_id === null ||
    uuid(authority.current_host_id) !== host_id
  )
    return fail("stale_host");
  const current = roomState(input.current_room);
  if (current && current.project_id !== request.project_id)
    return fail("room_changed");
  const operation_id = collaborationRoomReplacementOperationId(
    request.project_id,
    account_id,
    request.request_id,
  );

  if (input.receipt !== null) {
    const receipt = validateCollaborationRoomReplacementReceipt(input.receipt);
    if (
      receipt.operation_id !== operation_id ||
      receipt.request.expected_room_id !== request.expected_room_id ||
      receipt.request.expected_chat_path !== request.expected_chat_path
    )
      return fail("operation_conflict");
    if (!current || current.room_id !== receipt.replacement.room_id)
      return {
        action: "return",
        result: {
          outcome: "superseded",
          operation_id,
          replacement_room_id: receipt.replacement.room_id,
        },
      };
    // A supported move changes the locator, not the operation's room identity.
    return {
      action: "return",
      result: {
        outcome: current.initialized ? "ready" : "pending",
        operation_id,
        room: current,
      },
    };
  }

  if (
    !current ||
    current.room_id !== request.expected_room_id ||
    current.chat_path !== request.expected_chat_path
  )
    return fail("room_changed");
  if (!current.initialized) return fail("not_initialized");
  if (
    !Number.isSafeInteger(input.retained_operations) ||
    input.retained_operations < 0 ||
    input.retained_operations >= COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS
  )
    return fail("capacity_exceeded");
  const source_epoch = epoch(input.current_source_epoch);
  const room_home = absolutePath(authority.room_home ?? "/home/user");
  if (!request.expected_chat_path.startsWith(room_home + "/"))
    return fail("invalid_request");
  if (!input.absence) return fail("absence_required");
  const absence = record(input.absence, [
    "status",
    "project_id",
    "requesting_account_id",
    "host_id",
    "request_id",
    "room_id",
    "chat_path",
    "source_epoch",
  ]);
  if (
    absence.status !== "missing" ||
    uuid(absence.project_id) !== request.project_id ||
    uuid(absence.requesting_account_id) !== account_id ||
    uuid(absence.host_id) !== host_id ||
    uuid(absence.request_id) !== request.request_id ||
    uuid(absence.room_id) !== current.room_id ||
    chatPath(absence.chat_path) !== current.chat_path
  )
    return fail("absence_required");
  if (epoch(absence.source_epoch) !== source_epoch)
    return fail("source_changed");
  const receipt = validateCollaborationRoomReplacementReceipt({
    version: 1,
    operation_id,
    request,
    requesting_account_id: account_id,
    committing_host_id: host_id,
    room_home,
    previous_source_epoch: source_epoch,
    retired_source_epoch: uuidv5("retired-source", operation_id),
    replacement: replacementRoom(request.project_id, operation_id, room_home),
  });
  return {
    action: "commit",
    expected: { room: current, source_epoch },
    receipt,
    room: { ...receipt.replacement, initialized: false },
  };
}
