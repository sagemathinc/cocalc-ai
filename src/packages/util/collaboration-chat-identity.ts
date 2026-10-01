/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { v5 as uuidv5 } from "uuid";
import {
  CHAT_IDENTITY_EVENT,
  CHAT_IDENTITY_MAX_ENTRIES,
  buildChatIdentityMarkers,
  chatIdentityFail,
  chatIdentityId,
  chatIdentityKey,
  chatIdentityLegacyParent,
  chatIdentityMigrationId,
  chatIdentityRecord,
  chatIdentityStorageKey,
  chatIdentityTimestamp,
  readChatIdentityMarkers,
} from "./collaboration-chat-identity-markers";
import type {
  ChatIdentityEntry,
  ChatIdentityMarker,
  ChatIdentityStorageKey,
} from "./collaboration-chat-identity-markers";

export {
  ChatIdentityError,
  CHAT_IDENTITY_EVENT,
} from "./collaboration-chat-identity-markers";

export interface ResolvedChatIdentity {
  raw: Record<string, any>;
  storage_key: ChatIdentityStorageKey;
  message_id: string;
  thread_id: string;
  parent_message_id: string | null;
  /** Read projection only. Never pass this object to SyncDB.set. */
  projected: Record<string, any>;
}

export interface ChatIdentityResolution {
  rows: Record<string, any>[];
  messages: ResolvedChatIdentity[];
  byMessageId: Map<string, ResolvedChatIdentity>;
}

function sourceRows(input: readonly unknown[]): Record<string, any>[] {
  if (input.length > CHAT_IDENTITY_MAX_ENTRIES * 2)
    chatIdentityFail("capacity_exceeded");
  return input.map(chatIdentityRecord);
}

function explicitParent(row: Record<string, any>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(row, "parent_message_id") &&
    row.parent_message_id !== undefined
  );
}

function nativeIdentity(row: Record<string, any>): boolean {
  return !!chatIdentityId(row.message_id) && !!chatIdentityId(row.thread_id);
}

function needsLegacyParent(row: Record<string, any>): boolean {
  if (explicitParent(row) || (nativeIdentity(row) && row.schema_version >= 2))
    return false;
  return (
    !!chatIdentityId(row.reply_to_message_id) ||
    (row.reply_to != null && row.reply_to !== "")
  );
}

function mappedParent(
  row: Record<string, any>,
  mapped: ChatIdentityEntry,
): string | null {
  if (explicitParent(row)) return chatIdentityId(row.parent_message_id) ?? null;
  // SyncDB removes fields assigned null. Clearing all parent fields makes a
  // root without changing its bound thread or reviving the historical parent.
  if (
    !needsLegacyParent(row) &&
    (mapped.legacy_parent.parent_message_id ||
      mapped.legacy_parent.reply_to_message_id ||
      mapped.legacy_parent.reply_to != null)
  )
    return null;
  if (
    JSON.stringify(chatIdentityLegacyParent(row)) !==
    JSON.stringify(mapped.legacy_parent)
  )
    chatIdentityFail("changed_source");
  return mapped.parent_message_id;
}

/**
 * Strict all-or-error read projection. Marker-only identities are anchors, not
 * messages: deleted/offloaded rows must never be resurrected by this function.
 * Supply the saved head's markers when projecting an archive page.
 */
export function resolveChatIdentityRows(
  input: readonly unknown[],
): ChatIdentityResolution {
  const raw = sourceRows(input);
  const { entries } = readChatIdentityMarkers(raw);
  const messages: ResolvedChatIdentity[] = [];
  const byMessageId = new Map<string, ResolvedChatIdentity>();
  const byStorage = new Set<string>();
  const markerIds = new Map(
    [...entries].map(([key, entry]) => [entry.message_id, key]),
  );
  const rows = raw.map((row) => {
    if (row.event !== "chat") return row;
    const storage_key = chatIdentityStorageKey(row);
    const key = chatIdentityKey(storage_key);
    const mapped = entries.get(key);
    const message_id = chatIdentityId(row.message_id) ?? mapped?.message_id;
    const thread_id = chatIdentityId(row.thread_id) ?? mapped?.thread_id;
    if (!message_id || !thread_id || (!mapped && needsLegacyParent(row)))
      chatIdentityFail("missing_identity");
    if (byStorage.has(key) || byMessageId.has(message_id))
      chatIdentityFail("duplicate_identity");
    if (markerIds.has(message_id) && markerIds.get(message_id) !== key)
      chatIdentityFail("conflicting_identity");
    const parent_message_id = mapped
      ? mappedParent(row, mapped)
      : (chatIdentityId(row.parent_message_id) ?? null);
    if (parent_message_id === message_id) chatIdentityFail("cyclic_parent");
    const projected = {
      ...row,
      date: new Date(chatIdentityTimestamp(row.date)).toISOString(),
      message_id,
      thread_id,
      parent_message_id,
    };
    const resolved = {
      raw: row,
      storage_key,
      message_id,
      thread_id,
      parent_message_id,
      projected,
    };
    byStorage.add(key);
    byMessageId.set(message_id, resolved);
    messages.push(resolved);
    return projected;
  });
  for (const message of messages) {
    const parent =
      message.parent_message_id && byMessageId.get(message.parent_message_id);
    if (parent && parent.thread_id !== message.thread_id)
      chatIdentityFail("conflicting_identity");
  }
  return { rows, messages, byMessageId };
}

interface Vertex {
  raw: Record<string, any>;
  storage_key: ChatIdentityStorageKey;
  key: string;
  message_id: string;
  thread_id?: string;
  parent_message_id: string | null;
  mapped?: ChatIdentityEntry;
}

/**
 * Pure planner, not a persistence API or permission grant. The host must hold
 * lifecycle/source fences, attest complete head+archive input, persist the
 * operation ID before writes, and save chunks before their final manifest.
 * No message, configuration, enrollment, alias or content changes are returned.
 */
export function planChatIdentityMigration(
  input: readonly unknown[],
  options: { migration_id: string; history_complete: boolean },
): ChatIdentityMarker[] {
  if (options.history_complete !== true) chatIdentityFail("history_required");
  const migration_id = chatIdentityMigrationId(options.migration_id);
  const rows = sourceRows(input);
  const { entries, pending } = readChatIdentityMarkers(rows, migration_id);
  const vertices: Vertex[] = [];
  const byId = new Map<string, Vertex>();
  const byKey = new Set<string>();
  const byDate = new Map<number, Vertex[]>();
  for (const raw of rows) {
    if (raw.event !== "chat") continue;
    const storage_key = chatIdentityStorageKey(raw);
    const key = chatIdentityKey(storage_key);
    const mapped = entries.get(key);
    const message_id =
      chatIdentityId(raw.message_id) ??
      mapped?.message_id ??
      uuidv5(`message:${key}`, migration_id);
    if (byId.has(message_id) || byKey.has(key))
      chatIdentityFail("duplicate_identity");
    const vertex: Vertex = {
      raw,
      storage_key,
      key,
      message_id,
      thread_id: chatIdentityId(raw.thread_id) ?? mapped?.thread_id,
      parent_message_id: null,
      mapped,
    };
    vertices.push(vertex);
    byId.set(message_id, vertex);
    byKey.add(key);
    const date = chatIdentityTimestamp(raw.date);
    const bucket = byDate.get(date) ?? [];
    bucket.push(vertex);
    byDate.set(date, bucket);
  }
  if (vertices.length > CHAT_IDENTITY_MAX_ENTRIES)
    chatIdentityFail("capacity_exceeded");
  const missing = vertices.filter(
    (v) => !v.mapped && (!nativeIdentity(v.raw) || needsLegacyParent(v.raw)),
  );
  if (!missing.length) {
    if (pending.length) chatIdentityFail("changed_source");
    resolveChatIdentityRows(rows);
    return [];
  }
  for (const vertex of missing) {
    if ((byDate.get(chatIdentityTimestamp(vertex.raw.date))?.length ?? 0) !== 1)
      chatIdentityFail("ambiguous_timestamp");
  }
  for (const vertex of vertices) {
    const { raw, mapped } = vertex;
    if (mapped) vertex.parent_message_id = mappedParent(raw, mapped);
    else if (explicitParent(raw))
      vertex.parent_message_id = chatIdentityId(raw.parent_message_id) ?? null;
    else if (needsLegacyParent(raw)) {
      const parentId = chatIdentityId(raw.reply_to_message_id);
      let timestampParent: Vertex | undefined;
      if (raw.reply_to != null && raw.reply_to !== "") {
        const matches = byDate.get(chatIdentityTimestamp(raw.reply_to)) ?? [];
        if (!matches.length) chatIdentityFail("missing_parent");
        if (matches.length !== 1) chatIdentityFail("ambiguous_timestamp");
        timestampParent = matches[0];
      }
      if (
        parentId &&
        timestampParent &&
        parentId !== timestampParent.message_id
      )
        chatIdentityFail("conflicting_identity");
      vertex.parent_message_id =
        parentId ?? timestampParent?.message_id ?? null;
    }
    if (vertex.parent_message_id && !byId.has(vertex.parent_message_id))
      chatIdentityFail("missing_parent");
  }
  // Iterative root resolution keeps deeply nested historical threads stack safe.
  const roots = new Map<string, string>();
  for (const vertex of vertices) {
    const visited = new Set<string>();
    const path: Vertex[] = [];
    let current = vertex;
    while (!roots.has(current.message_id)) {
      if (visited.has(current.message_id)) chatIdentityFail("cyclic_parent");
      visited.add(current.message_id);
      path.push(current);
      if (!current.parent_message_id) {
        roots.set(current.message_id, current.message_id);
        break;
      }
      current = byId.get(current.parent_message_id)!;
    }
    const root = roots.get(current.message_id)!;
    for (const item of path) roots.set(item.message_id, root);
  }
  const threadByRoot = new Map<string, string>();
  const rootByThread = new Map<string, string>();
  for (const vertex of vertices) {
    if (!vertex.thread_id) continue;
    const root = roots.get(vertex.message_id)!;
    if (
      (threadByRoot.has(root) && threadByRoot.get(root) !== vertex.thread_id) ||
      (rootByThread.has(vertex.thread_id) &&
        rootByThread.get(vertex.thread_id) !== root)
    )
      chatIdentityFail("conflicting_identity");
    threadByRoot.set(root, vertex.thread_id);
    rootByThread.set(vertex.thread_id, root);
  }
  // Persisted legacy-thread timestamps are an existing identity, not a display
  // name. Preserve them only when they identify one exact, explicit root.
  for (const metadata of rows) {
    if (!["chat-thread", "chat-thread-config"].includes(metadata.event))
      continue;
    const thread_id = chatIdentityId(metadata.thread_id);
    if (!thread_id) continue;
    let root: Vertex | undefined;
    if (
      metadata.event === "chat-thread" &&
      chatIdentityId(metadata.root_message_id)
    )
      root = byId.get(metadata.root_message_id);
    const legacy = /^legacy-thread-(-?\d+)$/.exec(thread_id);
    if (!root && legacy) {
      const matches = byDate.get(chatIdentityTimestamp(legacy[1])) ?? [];
      if (matches.length > 1) chatIdentityFail("ambiguous_timestamp");
      root = matches[0];
    }
    if (!root) continue;
    if (
      roots.get(root.message_id) !== root.message_id ||
      (threadByRoot.has(root.message_id) &&
        threadByRoot.get(root.message_id) !== thread_id) ||
      (rootByThread.has(thread_id) &&
        rootByThread.get(thread_id) !== root.message_id)
    )
      chatIdentityFail("conflicting_identity");
    threadByRoot.set(root.message_id, thread_id);
    rootByThread.set(thread_id, root.message_id);
  }
  const additions = missing.map((vertex): ChatIdentityEntry => {
    const root = roots.get(vertex.message_id)!;
    const thread_id =
      threadByRoot.get(root) ??
      uuidv5(`thread:${byId.get(root)!.key}`, migration_id);
    threadByRoot.set(root, thread_id);
    return {
      storage_key: vertex.storage_key,
      message_id: vertex.message_id,
      thread_id,
      parent_message_id: vertex.parent_message_id,
      legacy_parent: chatIdentityLegacyParent(vertex.raw),
    };
  });
  const markers = buildChatIdentityMarkers(additions, migration_id);
  for (const old of pending) {
    const next = markers.find((row) => row.thread_id === old.thread_id);
    if (JSON.stringify(old) !== JSON.stringify(next))
      chatIdentityFail("changed_source");
  }
  const withoutPending = rows.filter(
    (row) =>
      row.event !== CHAT_IDENTITY_EVENT || row.migration_id !== migration_id,
  );
  resolveChatIdentityRows([...withoutPending, ...markers]);
  return markers;
}

/** Existing-row mutations must use this, not the logical IDs in a read projection. */
export function chatIdentityWritePatch(
  message: ResolvedChatIdentity,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...patch };
  for (const key of ["date", "sender_id", "event", "message_id", "thread_id"])
    delete next[key];
  return { ...next, ...message.storage_key };
}

/** Leave native documents untouched; only persisted markers enable the overlay. */
export function projectChatIdentityRows<T>(rows: readonly T[]): readonly T[] {
  if (!rows.some((row: any) => row?.event === CHAT_IDENTITY_EVENT)) return rows;
  return resolveChatIdentityRows(rows).rows as T[];
}

/** Translate a projected existing-row patch; genuinely new native rows pass through. */
export function chatIdentityMutation(
  rows: readonly unknown[],
  patch: Record<string, any>,
): Record<string, any> {
  if (
    patch.event !== "chat" ||
    !patch.message_id ||
    !rows.some((row: any) => row?.event === CHAT_IDENTITY_EVENT)
  )
    return patch;
  const message = resolveChatIdentityRows(rows).byMessageId.get(
    patch.message_id,
  );
  if (message) return chatIdentityWritePatch(message, patch);
  if (
    [...readChatIdentityMarkers(rows).entries.values()].some(
      (entry) => entry.message_id === patch.message_id,
    )
  )
    chatIdentityFail("missing_identity");
  return patch;
}
