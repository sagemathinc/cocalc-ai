/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export const COLLABORATION_NOTIFICATION_BATCH_LIMIT = 25;
export const COLLABORATION_MENTION_LIMIT = 1000;

export type CollaborationNotificationReason = "mention" | "thread_follow";

/** Immutable, service-produced message facts. Never include body text/snippets.
 * The journal assigns activity once per new message, not per scan/edit or clock.
 * First scans, adoption, restore and join backfills must not become live events.
 */
export interface CollaborationMessageEvent {
  version: 1;
  project_id: string;
  room_id: string;
  thread_id: string;
  message_id: string;
  actor_account_id: string;
  activity: number;
  mode: "live" | "backfill";
  mentioned_account_ids: string[];
  /** Evaluate against paginated, authorized recipients; never expand in a browser. */
  mention_all: boolean;
}

/** Service-internal transport, never an account/host-callable notification API. */
export interface CollaborationNotificationAuthority {
  project_id: string;
  room_id: string;
  thread_id: string;
  owning_bay_id: string;
  chat_path: string;
  access_generation: string;
  actor_role: string;
  recipient_role: string;
}

export interface CollaborationNotificationDelivery {
  event: CollaborationMessageEvent;
  account_id: string;
  /** Exact owner obligation retained until home acknowledgment. */
  obligation_id?: string;
  /** Capture with durable intent; never refresh a pending recipient on retry. */
  access_generation: string;
  /** Required by the concrete account-home attention adapter. */
  grant_request_id?: string | null;
  /** Owner-derived per-recipient facts, not a cached account projection. */
  attention?: CollaborationNotificationAttention;
}

export interface CollaborationNotificationAttention {
  generation: string;
  initial_activity: number;
  participating: boolean;
  legacy_following: boolean;
  legacy_muted: boolean;
}

export function validateCollaborationNotificationAttention(
  value: CollaborationNotificationAttention,
): CollaborationNotificationAttention {
  collaborationAccountId(value?.generation);
  collaborationActivity(value?.initial_activity);
  for (const key of [
    "participating",
    "legacy_following",
    "legacy_muted",
  ] as const)
    if (typeof value[key] !== "boolean")
      throw Error("invalid notification attention");
  return {
    generation: value.generation,
    initial_activity: value.initial_activity,
    participating: value.participating,
    legacy_following: value.legacy_following,
    legacy_muted: value.legacy_muted,
  };
}

export interface CollaborationNotificationObligation {
  project_id: string;
  id: string;
  account_id: string;
  membership_epoch: string;
}

/** Service-only retention proof; absence is checked at the current project owner. */
export interface CollaborationNotificationReceiptQuery {
  project_id: string;
  account_id: string;
  obligation_ids: string[];
}

export interface CollaborationNotificationEntry {
  event: CollaborationMessageEvent;
  authority: CollaborationNotificationAuthority;
  attention: CollaborationNotificationAttention;
}

export interface CollaborationAttentionState {
  following: boolean;
  muted: boolean;
  participating: boolean;
  read_through: number;
  /** Persisted starting boundary for this membership, not the last delivery. */
  notify_after: number;
  last_mention: number;
  legacy_migrated: boolean;
}

export interface LegacyCollaborationAttention {
  notification_followers?: string[];
  notification_muted?: string[];
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function collaborationAccountId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw Error("invalid collaboration account id");
  }
  return value.toLowerCase();
}

export function collaborationActivity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Error("invalid collaboration activity position");
  }
  return value;
}

function identity(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw Error("invalid collaboration message identity");
  }
  return value;
}

function accountIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > COLLABORATION_MENTION_LIMIT) {
    throw Error("collaboration account list exceeds capacity");
  }
  return [...new Set(values.map(collaborationAccountId))].sort();
}

export function validateCollaborationMessageEvent(
  event: CollaborationMessageEvent,
): CollaborationMessageEvent {
  if (
    !event ||
    event.version !== 1 ||
    !["live", "backfill"].includes(event.mode) ||
    typeof event.mention_all !== "boolean" ||
    collaborationActivity(event.activity) === 0
  ) {
    throw Error("invalid collaboration message event");
  }
  // Whitelist fields so accidental transcript metadata cannot reach the outbox.
  return {
    version: 1,
    project_id: collaborationAccountId(event.project_id),
    room_id: collaborationAccountId(event.room_id),
    thread_id: identity(event.thread_id),
    message_id: identity(event.message_id),
    actor_account_id: collaborationAccountId(event.actor_account_id),
    activity: event.activity,
    mode: event.mode,
    mentioned_account_ids: accountIds(event.mentioned_account_ids),
    mention_all: event.mention_all,
  };
}

/** Run once under the account-home attention lock, persisting the entire result.
 * Undefined means no personal choice; explicit false must not be overwritten by
 * legacy arrays. Do not pass DB default false as though it were a user choice.
 * Once migrated, ignore legacy writes and stop the browser notification writer.
 */
export function reconcileCollaborationAttention({
  account_id,
  initial_activity,
  state = {},
  legacy = {},
}: {
  account_id: string;
  initial_activity: number;
  state?: Partial<CollaborationAttentionState>;
  legacy?: LegacyCollaborationAttention;
}): CollaborationAttentionState {
  const account = collaborationAccountId(account_id);
  const initial = collaborationActivity(initial_activity);
  const migrated = state.legacy_migrated === true;
  const result: CollaborationAttentionState = {
    following:
      state.following ??
      (!migrated &&
        accountIds(legacy.notification_followers ?? []).includes(account)),
    muted:
      state.muted ??
      (!migrated &&
        accountIds(legacy.notification_muted ?? []).includes(account)),
    participating: state.participating ?? false,
    read_through: state.read_through ?? initial,
    notify_after: state.notify_after ?? initial,
    last_mention: state.last_mention ?? 0,
    legacy_migrated: true,
  };
  validateCollaborationAttention(result);
  return result;
}

export function validateCollaborationAttention(
  state: CollaborationAttentionState,
): void {
  if (!state) throw Error("missing collaboration attention state");
  for (const field of [
    "following",
    "muted",
    "participating",
    "legacy_migrated",
  ] as const) {
    if (typeof state[field] !== "boolean")
      throw Error("invalid collaboration attention state");
  }
  for (const field of [
    "read_through",
    "notify_after",
    "last_mention",
  ] as const) {
    collaborationActivity(state[field]);
  }
}

/** Apply with SQL GREATEST/CAS under the same lock as delivery, never last-write-wins. */
export function collaborationReadThrough({
  previous,
  requested,
  activity,
}: {
  previous: number;
  requested: number;
  activity: number;
}): number {
  return Math.max(
    collaborationActivity(previous),
    Math.min(collaborationActivity(requested), collaborationActivity(activity)),
  );
}

export function collaborationNotificationReason({
  event,
  account_id,
  state,
}: {
  event: CollaborationMessageEvent;
  account_id: string;
  state: CollaborationAttentionState;
}): CollaborationNotificationReason | undefined {
  const message = validateCollaborationMessageEvent(event);
  const account = collaborationAccountId(account_id);
  validateCollaborationAttention(state);
  if (!state.legacy_migrated)
    throw Error("collaboration attention must be reconciled before delivery");
  if (
    message.mode !== "live" ||
    message.actor_account_id === account ||
    message.activity <= Math.max(state.read_through, state.notify_after)
  )
    return;
  // Existing direct/mention-all semantics override mute, but never membership or read boundaries.
  if (message.mention_all || message.mentioned_account_ids.includes(account))
    return "mention";
  if (state.following && !state.muted) return "thread_follow";
}

export function collaborationForYouReason(
  state: CollaborationAttentionState,
): "mention" | "following" | "participation" | undefined {
  validateCollaborationAttention(state);
  if (state.last_mention > Math.max(state.read_through, state.notify_after))
    return "mention";
  if (state.following) return "following";
  if (state.participating) return "participation";
}

/** Locator, source writer epoch and membership generation are deliberately absent. */
export function collaborationNotificationKey(
  event: CollaborationMessageEvent,
  account_id: string,
  reason: CollaborationNotificationReason,
): string {
  const message = validateCollaborationMessageEvent(event);
  if (reason !== "mention" && reason !== "thread_follow")
    throw Error("invalid collaboration notification reason");
  return JSON.stringify([
    "collaboration-message-v1",
    message.project_id,
    message.room_id,
    message.thread_id,
    message.message_id,
    collaborationAccountId(account_id),
    reason,
  ]);
}
