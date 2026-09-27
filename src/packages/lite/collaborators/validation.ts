/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { posix } from "node:path";
import { validateCollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import type { CollaborationMessageEvent } from "@cocalc/util/collaboration-attention";
import type { LocalResource } from "./legacy-attention";
import {
  COLLABORATION_MAX_SOURCE_BYTES,
  COLLABORATION_MAX_SOURCE_RESOURCES,
  COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
} from "@cocalc/util/collaborators";
import type {
  CollaborationPersonalState,
  CollaborationResourceKind,
  CollaborationSourceSnapshot,
} from "@cocalc/util/collaborators";

export const MAX_RESOURCE_BYTES = 16 * 1024;
export const MAX_PAGE_BYTES = 256 * 1024;
export const MAX_RESOURCES = 100_000;
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCES = 10_000;
export const MAX_SOURCE_PATH_BYTES = 16 * 1024 * 1024;
export const MAX_WORK_PER_HOUR = 1_000_000;

export type LocalCollaborationSnapshot = Omit<
  CollaborationSourceSnapshot,
  "resources"
> & {
  resources: LocalResource[];
  notification_events?: CollaborationMessageEvent[];
};

export function text(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw Error(`invalid collaborators ${field}`);
  }
  return value;
}

export function position(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw Error(`invalid collaborators ${field}`);
  return value as number;
}

export function kind(value: unknown): CollaborationResourceKind {
  if (value !== "conversation" && value !== "agent" && value !== "artifact")
    throw Error("invalid collaborators resource kind");
  return value;
}

export function chatPath(value: unknown): string {
  const path = text(value, "chat path", 4096);
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.includes("\\") ||
    !/\.(sage-)?chat$/.test(path)
  )
    throw Error("invalid collaborators canonical chat path");
  return path;
}

export function snapshot(
  input: LocalCollaborationSnapshot,
): LocalCollaborationSnapshot {
  const project_id = text(input.project_id, "project");
  const chat_path = chatPath(input.chat_path);
  const epoch = text(input.epoch, "epoch");
  const sequence = position(input.sequence, "sequence");
  if (
    !sequence ||
    !Array.isArray(input.resources) ||
    input.resources.length > COLLABORATION_MAX_SOURCE_RESOURCES
  )
    throw Error("invalid collaborators source snapshot");
  // Check the wire payload too, before stripping unsupported/content fields.
  if (Buffer.byteLength(JSON.stringify(input)) > COLLABORATION_MAX_SOURCE_BYTES)
    throw Error("collaborators source byte limit exceeded");
  const seen = new Set<string>();
  const resources = input.resources.map((item): LocalResource => {
    const type = kind(item.kind);
    const resource_id = text(item.resource_id, "resource", 256);
    const key = JSON.stringify([type, resource_id]);
    if (
      item.project_id !== project_id ||
      item.chat_path !== chat_path ||
      seen.has(key)
    )
      throw Error("collaborators source mismatch or duplicate identity");
    seen.add(key);
    if (
      !Array.isArray(item.participant_ids) ||
      item.participant_ids.length > COLLABORATION_PARTICIPANT_SUMMARY_LIMIT
    )
      throw Error("invalid collaborators participants");
    const result: LocalResource = {
      project_id,
      kind: type,
      resource_id,
      title: text(item.title, "title", 512),
      chat_path,
      thread_id: text(item.thread_id, "thread"),
      participant_ids: [
        ...new Set(item.participant_ids.map((id) => text(id, "participant"))),
      ].sort(),
      created_at: position(item.created_at, "created time"),
      updated_at: position(item.updated_at, "updated time"),
      activity: position(item.activity, "activity"),
    };
    if (item.lite_legacy_attention !== undefined) {
      const legacy = item.lite_legacy_attention;
      if (
        type === "artifact" ||
        !legacy ||
        typeof legacy.following !== "boolean" ||
        typeof legacy.muted !== "boolean"
      )
        throw Error("invalid local legacy attention");
      result.lite_legacy_attention = {
        following: legacy.following,
        muted: legacy.muted,
      };
    }
    if (item.participant_count !== undefined) {
      result.participant_count = position(
        item.participant_count,
        "participant count",
      );
      if (result.participant_count < result.participant_ids.length)
        throw Error("invalid collaborators participant count");
    }
    if (item.participants_truncated !== undefined) {
      if (typeof item.participants_truncated !== "boolean")
        throw Error("invalid collaborators participant truncation flag");
      result.participants_truncated = item.participants_truncated;
    }
    if ((result.participant_count ?? 0) > result.participant_ids.length)
      result.participants_truncated = true;
    for (const field of [
      "created_by",
      "agent_id",
      "artifact_id",
      "entry_id",
    ] as const) {
      if (item[field] !== undefined) result[field] = text(item[field], field);
    }
    if (item.archived !== undefined) {
      if (typeof item.archived !== "boolean")
        throw Error("invalid archived flag");
      result.archived = item.archived;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESOURCE_BYTES)
      throw Error("collaborators resource byte limit exceeded");
    return result;
  });
  resources.sort((a, b) => {
    const left = JSON.stringify([a.kind, a.resource_id]);
    const right = JSON.stringify([b.kind, b.resource_id]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (
    input.coverage !== undefined &&
    input.coverage !== "complete" &&
    input.coverage !== "partial"
  )
    throw Error("invalid collaborators source coverage");
  const coverage = resources.some((item) => item.participants_truncated)
    ? "partial"
    : input.coverage;
  let notification_events: CollaborationMessageEvent[] | undefined;
  if (input.notification_events !== undefined) {
    if (
      !Array.isArray(input.notification_events) ||
      input.notification_events.length > 100
    )
      throw Error("collaborators notification batch exceeds capacity");
    const seenEvents = new Set<string>();
    const conversations = new Map(
      resources
        .filter((item) => item.kind === "conversation")
        .map((item) => [item.thread_id, item]),
    );
    notification_events = input.notification_events.map((raw) => {
      const event = validateCollaborationMessageEvent(raw);
      const resource = conversations.get(event.thread_id);
      const key = JSON.stringify([
        event.room_id,
        event.thread_id,
        event.message_id,
      ]);
      if (
        event.project_id !== project_id ||
        !resource ||
        event.activity > resource.activity ||
        seenEvents.has(key)
      )
        throw Error(
          "collaborators notification source mismatch or duplicate identity",
        );
      seenEvents.add(key);
      return event;
    });
  }
  return {
    project_id,
    chat_path,
    epoch,
    sequence,
    resources,
    ...(notification_events ? { notification_events } : {}),
    ...(coverage ? { coverage } : {}),
    ...(input.coverage_message !== undefined
      ? {
          coverage_message: text(
            input.coverage_message,
            "source coverage message",
            512,
          ),
        }
      : {}),
  };
}

export function personalPatch(
  input: Partial<CollaborationPersonalState>,
): Partial<CollaborationPersonalState> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("invalid collaborators personal state patch");
  const result: Partial<CollaborationPersonalState> = {};
  for (const field of Object.keys(input)) {
    if (
      !["alias", "collected", "following", "muted", "read_through"].includes(
        field,
      )
    )
      throw Error("invalid collaborators personal state field");
  }
  if (Object.prototype.hasOwnProperty.call(input, "alias")) {
    if (typeof input.alias !== "string")
      throw Error("invalid collaborators alias");
    const alias = input.alias.trim().replace(/^@/, "").toLowerCase();
    if (alias && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(alias))
      throw Error("invalid collaborators alias");
    result.alias = alias;
  }
  for (const field of ["collected", "following", "muted"] as const) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      if (typeof input[field] !== "boolean")
        throw Error(`invalid collaborators ${field}`);
      result[field] = input[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "read_through"))
    result.read_through = position(input.read_through, "read position");
  return result;
}

/** Literal, token-prefix metadata search, never user-supplied FTS syntax. */
export function searchTerms(input?: string): string[] {
  if (input === undefined || input === "") return [];
  text(input, "search", 200);
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length > 12) throw Error("too many collaborators search terms");
  return tokens;
}
