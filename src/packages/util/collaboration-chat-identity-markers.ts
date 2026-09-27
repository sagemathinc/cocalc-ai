/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { v5 as uuidv5 } from "uuid";

export const CHAT_IDENTITY_EVENT = "chat-legacy-identity";
export const CHAT_IDENTITY_MAX_ENTRIES = 100_000;
export const CHAT_IDENTITY_CHUNK_SIZE = 128;
const MAX_BYTES = 32 * 1024 * 1024;
const DATE = "1970-01-01T00:00:00.000Z";
const SENDER = "__chat_legacy_identity__";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const has = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export type ChatIdentityErrorCode =
  | "invalid_row"
  | "invalid_timestamp"
  | "invalid_marker"
  | "incomplete_marker"
  | "capacity_exceeded"
  | "history_required"
  | "missing_identity"
  | "duplicate_identity"
  | "ambiguous_timestamp"
  | "missing_parent"
  | "conflicting_identity"
  | "cyclic_parent"
  | "changed_source";

export class ChatIdentityError extends Error {
  constructor(readonly code: ChatIdentityErrorCode) {
    super(`chat identity: ${code}`);
    this.name = "ChatIdentityError";
  }
}

export function chatIdentityFail(code: ChatIdentityErrorCode): never {
  throw new ChatIdentityError(code);
}

export interface ChatIdentityStorageKey {
  event: "chat";
  date: string | number;
  sender_id: string;
  message_id?: string | null;
  thread_id?: string | null;
}

export interface ChatIdentityLegacyParent {
  reply_to?: string | number | null;
  reply_to_message_id?: string | null;
  parent_message_id?: string | null;
}

export interface ChatIdentityEntry {
  storage_key: ChatIdentityStorageKey;
  message_id: string;
  thread_id: string;
  parent_message_id: string | null;
  /** Detect legacy rewiring; explicit native parent changes remain authoritative. */
  legacy_parent: ChatIdentityLegacyParent;
}

interface MarkerBase {
  event: typeof CHAT_IDENTITY_EVENT;
  sender_id: typeof SENDER;
  date: typeof DATE;
  thread_id: string;
  schema_version: 1;
  migration_id: string;
}
export interface ChatIdentityChunk extends MarkerBase {
  record_type: "chunk";
  part: number;
  entries: ChatIdentityEntry[];
}
export interface ChatIdentityManifest extends MarkerBase {
  record_type: "manifest";
  part_count: number;
  entry_count: number;
  digest: string;
}
export type ChatIdentityMarker = ChatIdentityChunk | ChatIdentityManifest;

export function chatIdentityRecord(value: unknown): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    chatIdentityFail("invalid_row");
  return value as Record<string, any>;
}

export function chatIdentityId(value: unknown): string | undefined {
  if (value == null || value === "") return;
  if (typeof value !== "string" || value.length > 200 || value.trim() !== value)
    chatIdentityFail("invalid_row");
  return value;
}

/** Only exact epoch milliseconds or ISO timestamps with explicit timezone. */
export function chatIdentityTimestamp(value: unknown): number {
  if (typeof value === "string" && /^-?(?:0|[1-9]\d{0,15})$/.test(value)) {
    value = Number(value);
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15) return value;
    return chatIdentityFail("invalid_timestamp");
  }
  if (typeof value !== "string") return chatIdentityFail("invalid_timestamp");
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!m) return chatIdentityFail("invalid_timestamp");
  const [, year, month, day, hour, minute, second, fraction = "", zone] = m;
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59)
    return chatIdentityFail("invalid_timestamp");
  const offset =
    (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const ms = Date.parse(value);
  const local = new Date(ms + offset * 60_000);
  if (
    !Number.isFinite(ms) ||
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute) ||
    local.getUTCSeconds() !== Number(second) ||
    local.getUTCMilliseconds() !== Number(fraction.padEnd(3, "0"))
  )
    return chatIdentityFail("invalid_timestamp");
  return ms;
}

/** Preserve null/absence, timestamp spelling/type, and all original identity keys. */
export function chatIdentityStorageKey(value: unknown): ChatIdentityStorageKey {
  const row = chatIdentityRecord(value);
  if (
    row.event !== "chat" ||
    typeof row.sender_id !== "string" ||
    !row.sender_id.length ||
    row.sender_id.length > 512
  )
    chatIdentityFail("invalid_row");
  chatIdentityTimestamp(row.date);
  const key: ChatIdentityStorageKey = {
    event: "chat",
    date: row.date,
    sender_id: row.sender_id,
  };
  for (const field of ["message_id", "thread_id"] as const) {
    chatIdentityId(row[field]);
    if (has(row, field) && row[field] !== undefined) key[field] = row[field];
  }
  return key;
}

export function chatIdentityKey(value: ChatIdentityStorageKey): string {
  return JSON.stringify(chatIdentityStorageKey(value));
}

export function chatIdentityLegacyParent(
  value: unknown,
): ChatIdentityLegacyParent {
  const row = chatIdentityRecord(value);
  const parent: ChatIdentityLegacyParent = {};
  if (has(row, "reply_to") && row.reply_to !== undefined) {
    if (row.reply_to != null && row.reply_to !== "")
      chatIdentityTimestamp(row.reply_to);
    parent.reply_to = row.reply_to;
  }
  if (
    has(row, "reply_to_message_id") &&
    row.reply_to_message_id !== undefined
  ) {
    chatIdentityId(row.reply_to_message_id);
    parent.reply_to_message_id = row.reply_to_message_id;
  }
  if (has(row, "parent_message_id") && row.parent_message_id !== undefined) {
    chatIdentityId(row.parent_message_id);
    parent.parent_message_id = row.parent_message_id;
  }
  return parent;
}

function exactKeys(row: Record<string, any>, keys: string[]) {
  if (Object.keys(row).some((key) => !keys.includes(key)))
    chatIdentityFail("invalid_marker");
}

function entry(value: unknown): ChatIdentityEntry {
  const row = chatIdentityRecord(value);
  exactKeys(row, [
    "storage_key",
    "message_id",
    "thread_id",
    "parent_message_id",
    "legacy_parent",
  ]);
  const storage_key = chatIdentityStorageKey(row.storage_key);
  exactKeys(row.storage_key, Object.keys(storage_key));
  const message_id = chatIdentityId(row.message_id);
  const thread_id = chatIdentityId(row.thread_id);
  const parent_message_id = chatIdentityId(row.parent_message_id);
  if (
    !message_id ||
    !thread_id ||
    (row.parent_message_id !== null && !parent_message_id) ||
    message_id === parent_message_id ||
    (chatIdentityId(storage_key.message_id) &&
      storage_key.message_id !== message_id) ||
    (chatIdentityId(storage_key.thread_id) &&
      storage_key.thread_id !== thread_id)
  )
    chatIdentityFail("invalid_marker");
  const legacy_parent = chatIdentityLegacyParent(row.legacy_parent);
  exactKeys(row.legacy_parent, Object.keys(legacy_parent));
  return {
    storage_key,
    message_id,
    thread_id,
    parent_message_id: parent_message_id ?? null,
    legacy_parent,
  };
}

export function chatIdentityMigrationId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    chatIdentityFail("invalid_marker");
  return value.toLowerCase();
}

function markerBase(migration_id: string, part: string): MarkerBase {
  return {
    event: CHAT_IDENTITY_EVENT,
    sender_id: SENDER,
    date: DATE,
    thread_id: `${SENDER}:${migration_id}:${part}`,
    schema_version: 1,
    migration_id,
  };
}

function digest(entries: ChatIdentityEntry[], migration_id: string) {
  return uuidv5(JSON.stringify(entries), migration_id);
}

export function buildChatIdentityMarkers(
  input: readonly ChatIdentityEntry[],
  migrationId: string,
): ChatIdentityMarker[] {
  const migration_id = chatIdentityMigrationId(migrationId);
  if (!input.length || input.length > CHAT_IDENTITY_MAX_ENTRIES)
    chatIdentityFail("capacity_exceeded");
  const entries = input.map(entry).sort((a, b) => {
    const first = chatIdentityKey(a.storage_key),
      second = chatIdentityKey(b.storage_key);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const markers: ChatIdentityMarker[] = [];
  for (
    let start = 0;
    start < entries.length;
    start += CHAT_IDENTITY_CHUNK_SIZE
  ) {
    const part = markers.length;
    markers.push({
      ...markerBase(migration_id, `${part}`),
      record_type: "chunk",
      part,
      entries: entries.slice(start, start + CHAT_IDENTITY_CHUNK_SIZE),
    });
  }
  markers.push({
    ...markerBase(migration_id, "manifest"),
    record_type: "manifest",
    part_count: markers.length,
    entry_count: entries.length,
    digest: digest(entries, migration_id),
  });
  if (new TextEncoder().encode(JSON.stringify(markers)).length > MAX_BYTES)
    chatIdentityFail("capacity_exceeded");
  return markers;
}

/** A manifest is usable only with every validated chunk. Markers are not authority. */
export function readChatIdentityMarkers(
  rows: readonly unknown[],
  pendingMigrationId?: string,
): { entries: Map<string, ChatIdentityEntry>; pending: ChatIdentityMarker[] } {
  const groups = new Map<string, ChatIdentityMarker[]>();
  let bytes = 0;
  for (const value of rows) {
    const row = chatIdentityRecord(value);
    if (row.event !== CHAT_IDENTITY_EVENT) continue;
    if (
      (bytes += new TextEncoder().encode(JSON.stringify(row)).length) >
      MAX_BYTES
    )
      chatIdentityFail("capacity_exceeded");
    const migration_id = chatIdentityMigrationId(row.migration_id);
    const isChunk = row.record_type === "chunk";
    const base = markerBase(migration_id, isChunk ? `${row.part}` : "manifest");
    if (Object.entries(base).some(([key, value]) => row[key] !== value))
      chatIdentityFail("invalid_marker");
    exactKeys(row, [
      ...Object.keys(base),
      "record_type",
      ...(isChunk
        ? ["part", "entries"]
        : ["part_count", "entry_count", "digest"]),
    ]);
    let marker: ChatIdentityMarker;
    if (isChunk) {
      if (
        !Number.isSafeInteger(row.part) ||
        row.part < 0 ||
        row.part >=
          Math.ceil(CHAT_IDENTITY_MAX_ENTRIES / CHAT_IDENTITY_CHUNK_SIZE) ||
        !Array.isArray(row.entries) ||
        !row.entries.length ||
        row.entries.length > CHAT_IDENTITY_CHUNK_SIZE
      )
        chatIdentityFail("invalid_marker");
      marker = {
        ...base,
        record_type: "chunk",
        part: row.part,
        entries: row.entries.map(entry),
      };
    } else {
      if (
        row.record_type !== "manifest" ||
        !Number.isSafeInteger(row.entry_count) ||
        row.entry_count <= 0 ||
        row.entry_count > CHAT_IDENTITY_MAX_ENTRIES ||
        row.part_count !==
          Math.ceil(row.entry_count / CHAT_IDENTITY_CHUNK_SIZE) ||
        typeof row.digest !== "string" ||
        !UUID.test(row.digest)
      )
        chatIdentityFail("invalid_marker");
      marker = {
        ...base,
        record_type: "manifest",
        part_count: row.part_count,
        entry_count: row.entry_count,
        digest: row.digest,
      };
    }
    const group = groups.get(migration_id) ?? [];
    if (group.some((old) => old.thread_id === marker.thread_id))
      chatIdentityFail("invalid_marker");
    group.push(marker);
    groups.set(migration_id, group);
  }
  const entries = new Map<string, ChatIdentityEntry>();
  const ids = new Map<string, string>();
  const pending: ChatIdentityMarker[] = [];
  for (const [migration_id, group] of groups) {
    const manifest = group.find(
      (row): row is ChatIdentityManifest => row.record_type === "manifest",
    );
    const chunks = group
      .filter((row): row is ChatIdentityChunk => row.record_type === "chunk")
      .sort((a, b) => a.part - b.part);
    if (
      !manifest ||
      chunks.length !== manifest.part_count ||
      chunks.some((row, i) => row.part !== i)
    ) {
      if (migration_id === pendingMigrationId) {
        pending.push(...group);
        continue;
      }
      chatIdentityFail("incomplete_marker");
    }
    const mapped = chunks.flatMap((row) => row.entries);
    if (
      mapped.length !== manifest.entry_count ||
      digest(mapped, migration_id) !== manifest.digest
    )
      chatIdentityFail("invalid_marker");
    for (const item of mapped) {
      const key = chatIdentityKey(item.storage_key);
      const old = entries.get(key);
      if (old || ids.has(item.message_id))
        chatIdentityFail("duplicate_identity");
      entries.set(key, item);
      ids.set(item.message_id, key);
      if (entries.size > CHAT_IDENTITY_MAX_ENTRIES)
        chatIdentityFail("capacity_exceeded");
    }
  }
  for (const item of entries.values()) {
    if (!item.parent_message_id) continue;
    const parentKey = ids.get(item.parent_message_id);
    if (parentKey && entries.get(parentKey)!.thread_id !== item.thread_id)
      chatIdentityFail("conflicting_identity");
  }
  const checked = new Set<string>();
  for (const item of entries.values()) {
    const path = new Set<string>();
    let current: ChatIdentityEntry | undefined = item;
    while (current && !checked.has(current.message_id)) {
      if (path.has(current.message_id)) chatIdentityFail("cyclic_parent");
      path.add(current.message_id);
      const parentKey: string | undefined = current.parent_message_id
        ? ids.get(current.parent_message_id)
        : undefined;
      current = parentKey ? entries.get(parentKey) : undefined;
    }
    for (const id of path) checked.add(id);
  }
  return { entries, pending };
}
