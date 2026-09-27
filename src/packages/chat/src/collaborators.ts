/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  COLLABORATION_MAX_SOURCE_RESOURCES,
  COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
  COLLABORATION_ROOM_PATH,
  type CollaborationResource,
} from "@cocalc/util/collaborators";
import { uuidsha1 } from "@cocalc/util/misc";
import { agentThreadResourceId } from "@cocalc/util/collaboration-agent-identity";
import {
  COLLABORATION_MENTION_LIMIT,
  collaborationAccountId,
  type LegacyCollaborationAttention,
} from "@cocalc/util/collaboration-attention";
import { extractArtifactCatalog } from "./artifact-catalog";
import { extractCollaborationMessageFacts } from "./collaborators-notifications";
import type { CollaborationMessageFacts } from "./collaborators-notifications";
import { collaborationIdentityNamespace } from "./collaborators-copy";
export {
  collaborationCopyFingerprint,
  collaborationIdentityNamespace,
  initializeCollaborationCopy,
} from "./collaborators-copy";
export {
  collaborationMessageMentions,
  extractCollaborationMessageFacts,
} from "./collaborators-notifications";
export type { CollaborationMessageFacts } from "./collaborators-notifications";

export interface CollaborationExtraction {
  resources: CollaborationResource[];
  /** Stable message/publication IDs, never message text or client clock positions. */
  activity_ids: Record<string, string[]>;
  coverage?: "complete" | "partial";
  coverage_message?: string;
  notification_room_id?: string;
  notification_messages?: CollaborationMessageFacts[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const time = (value: unknown): number => {
  const n = Date.parse(text(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
function legacyAttention(
  config?: Record<string, any>,
): LegacyCollaborationAttention {
  const hints: LegacyCollaborationAttention = {};
  for (const key of ["notification_followers", "notification_muted"] as const) {
    const value = config?.[key];
    if (value == null) continue;
    if (!Array.isArray(value) || value.length > COLLABORATION_MENTION_LIMIT)
      throw Error(
        "legacy collaboration attention exceeds account list capacity",
      );
    hints[key] = [...new Set(value.map(collaborationAccountId))].sort();
  }
  return hints;
}

/** A complete bounded source, independent of personal aliases or agent enrollment. */
export function extractCollaborationMetadata(
  input: Iterable<unknown>,
  source: { project_id: string; chat_path: string },
  { humanRoomPath = COLLABORATION_ROOM_PATH }: { humanRoomPath?: string } = {},
): CollaborationExtraction {
  const rows: Record<string, any>[] = [];
  const threads = new Map<string, Record<string, any>>();
  const configs = new Map<string, Record<string, any>>();
  const messages = new Map<string, Map<string, Record<string, any>>>();
  const publications = new Map<string, Record<string, any>[]>();
  for (const value of input) {
    if (!value || typeof value !== "object") throw Error("invalid chat row");
    const row = value as Record<string, any>;
    rows.push(row);
    if (rows.length > 100_000)
      throw Error("collaboration source exceeds row capacity");
    if (row.event === "chat-artifact-publication") {
      const key = JSON.stringify([row.thread_id, row.artifact_id]);
      const group = publications.get(key) ?? [];
      group.push(row);
      publications.set(key, group);
    }
    if (!["chat", "chat-thread", "chat-thread-config"].includes(row.event))
      continue;
    const id = text(row.thread_id);
    // Timestamp-only legacy threads need explicit identity migration first.
    // Reject the whole scan: silently omitting rows would publish deletions.
    if (!id || id.length > 200)
      throw Error("chat source needs durable thread identities");
    if (row.event === "chat") {
      const message = text(row.message_id);
      if (!message || message.length > 200)
        throw Error("chat source needs durable message identities");
      let group = messages.get(id);
      if (!group) messages.set(id, (group = new Map()));
      if (group.has(message)) throw Error("duplicate chat message identity");
      group.set(message, row);
    } else {
      const target = row.event === "chat-thread" ? threads : configs;
      if (target.has(id)) throw Error("duplicate chat thread metadata");
      target.set(id, row);
    }
  }
  const resources: CollaborationResource[] = [];
  const namespace = collaborationIdentityNamespace(rows);
  const identity = (native: string) =>
    namespace
      ? `copy:${uuidsha1(JSON.stringify([namespace, native]))}`
      : native;
  const activity_ids: Record<string, string[]> = Object.create(null);
  let partialParticipants = false;
  let partialArchive = false;
  for (const id of new Set([
    ...threads.keys(),
    ...configs.keys(),
    ...messages.keys(),
  ])) {
    const thread = threads.get(id);
    const config = configs.get(id);
    const hasArchive = Number(config?.archived_chat_rows) > 0;
    if (hasArchive) partialArchive = true;
    const group = [...(messages.get(id)?.values() ?? [])];
    const agent =
      config?.agent_kind !== "none" &&
      (config?.agent_kind === "acp" ||
        config?.agent_kind === "llm" ||
        config?.acp_config != null ||
        !!text(config?.agent_model) ||
        group.some((row) => !!row.acp_thread_id));
    const kind = agent ? "agent" : "conversation";
    const resource_id = identity(agent ? agentThreadResourceId(id) : id);
    const participants = [
      ...new Set(
        group.map((row) => text(row.sender_id)).filter((id) => UUID.test(id)),
      ),
    ].sort();
    const participants_truncated =
      participants.length > COLLABORATION_PARTICIPANT_SUMMARY_LIMIT;
    if (participants_truncated) partialParticipants = true;
    const dates = group.map((row) => time(row.date)).filter(Boolean);
    const created_at =
      time(thread?.created_at) || (dates.length ? Math.min(...dates) : 0);
    const created_by = text(thread?.created_by);
    resources.push({
      ...source,
      kind,
      resource_id,
      thread_id: id,
      title: (
        text(config?.name) ||
        (agent ? "Untitled agent" : "Untitled conversation")
      ).slice(0, 512),
      ...(UUID.test(created_by) ? { created_by } : {}),
      participant_ids: participants.slice(
        0,
        COLLABORATION_PARTICIPANT_SUMMARY_LIMIT,
      ),
      ...(!hasArchive || participants_truncated
        ? { participant_count: participants.length }
        : {}),
      participants_truncated,
      created_at,
      // Metadata changes must not reorder conversations as new activity.
      updated_at: Math.max(
        created_at,
        ...dates,
        Number.isSafeInteger(config?.latest_chat_date_ms) &&
          config!.latest_chat_date_ms >= 0
          ? config!.latest_chat_date_ms
          : 0,
      ),
      activity: 0,
      // Migration hints only. Copies do not inherit another thread's subscriptions.
      ...(!namespace && !agent ? legacyAttention(config) : {}),
      ...(config?.archived === true ? { archived: true } : {}),
    });
    activity_ids[resource_id] = [...(messages.get(id)?.keys() ?? [])].sort();
  }
  const byThread = new Map(
    resources.map((resource) => [resource.thread_id, resource]),
  );
  for (const artifact of extractArtifactCatalog(rows)) {
    const thread = byThread.get(artifact.thread_id);
    const resource_id = identity(
      `artifact:${uuidsha1(JSON.stringify([artifact.thread_id, artifact.artifact_id]))}`,
    );
    const published =
      publications.get(
        JSON.stringify([artifact.thread_id, artifact.artifact_id]),
      ) ?? [];
    resources.push({
      ...source,
      kind: "artifact",
      resource_id,
      thread_id: artifact.thread_id,
      artifact_id: artifact.artifact_id,
      title: artifact.title,
      // A thread's creator is not necessarily an artifact's publisher.
      participant_ids: [],
      created_at: artifact.created_at,
      updated_at: Math.max(
        artifact.created_at,
        ...published.map((row) => time(row.published_at)),
      ),
      activity: 0,
      ...(thread?.archived ? { archived: true } : {}),
    });
    activity_ids[resource_id] = published.map((row) => row.operation_id).sort();
  }
  if (resources.length > COLLABORATION_MAX_SOURCE_RESOURCES)
    throw Error("collaboration source exceeds resource capacity");
  resources.sort((a, b) =>
    a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0,
  );
  const markers = rows.filter((row) => row.event === "collaborators-room");
  let notifications: Pick<
    CollaborationExtraction,
    "notification_room_id" | "notification_messages"
  > = {};
  if (!namespace && source.chat_path === humanRoomPath && markers.length) {
    if (
      markers.length !== 1 ||
      markers[0].project_id !== source.project_id ||
      !UUID.test(markers[0].room_id) ||
      markers[0].mode !== "human"
    )
      throw Error("invalid canonical human room notification identity");
    notifications = {
      notification_room_id: markers[0].room_id,
      notification_messages: extractCollaborationMessageFacts(rows, {
        project_id: source.project_id,
        room_id: markers[0].room_id,
      }),
    };
  }
  return {
    resources,
    activity_ids,
    ...notifications,
    ...(partialParticipants || partialArchive
      ? {
          coverage: "partial" as const,
          coverage_message: [
            ...(partialParticipants
              ? [
                  `Participant summaries include at most ${COLLABORATION_PARTICIPANT_SUMMARY_LIMIT} people per conversation. Additional participants remain in the source chat but are not available to person filters.`,
                ]
              : []),
            ...(partialArchive
              ? [
                  "Archived message history is not included in participant summaries; historical participant counts and person filters are incomplete.",
                ]
              : []),
          ].join(" "),
        }
      : {}),
  };
}
