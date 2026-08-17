/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  createHeadlessChatClient,
  PROJECT_CHAT_SESSION_NOT_FOUND,
  PROJECT_CHAT_SESSION_SERVICE,
  type ChatSnapshot,
  type ProjectChatSessionOpenResponse,
  type ProjectChatSessionStreamEvent,
  type HeadlessChatClient,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import type { Client } from "@cocalc/conat/core/client";
import { dstream, type DStream } from "@cocalc/conat/sync/dstream";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("project-host:project-chat-session");

export const PROJECT_CHAT_SESSION_SUBJECT = `services.*.*.*.*.${PROJECT_CHAT_SESSION_SERVICE}`;

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 500;
const INITIAL_MAX_BYTES = 512 * 1024;
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 128 * 1024;
const MAX_SESSIONS = 200;
const SESSION_IDLE_MS = 20 * 60_000;
const UPDATE_THROTTLE_MS = 200;
const STREAM_MAX_AGE_MS = 60 * 60_000;

interface ChatIdentity {
  account_id: string;
  project_id: string;
}

interface Session extends ChatIdentity {
  id: string;
  path: string;
  limit: number;
  touchedAt: number;
  backend: HeadlessChatClient;
  stream: DStream<ProjectChatSessionStreamEvent>;
  snapshot: ChatSnapshot;
  unsubscribe: () => void;
  updateTimer?: ReturnType<typeof setTimeout>;
  publishQueue: Promise<void>;
}

function parseSubject(subject?: string): ChatIdentity {
  const parts = `${subject ?? ""}`.split(".");
  if (
    parts.length !== 6 ||
    parts[0] !== "services" ||
    parts[5] !== PROJECT_CHAT_SESSION_SERVICE
  ) {
    throw new Error(`invalid project chat session subject '${subject ?? ""}'`);
  }
  const account_id = `${parts[1] ?? ""}`.startsWith("account-")
    ? parts[1].slice("account-".length)
    : "";
  const project_id = `${parts[3] ?? ""}`.trim();
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error(`invalid project chat session subject '${subject ?? ""}'`);
  }
  return { account_id, project_id };
}

function assertCollaborator({ account_id, project_id }: ChatIdentity): void {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  if (!isProjectCollaboratorGroup(group)) {
    throw new Error(
      `account '${account_id}' is not a collaborator on project '${project_id}'`,
    );
  }
}

export function normalizeProjectChatPath(path: unknown): string {
  const value = `${path ?? ""}`.trim();
  const normalized = posix.normalize(value);
  if (
    value.includes("\0") ||
    !normalized.startsWith("/home/user/") ||
    (!normalized.endsWith(".chat") && !normalized.endsWith(".sage-chat"))
  ) {
    throw new Error(
      "a valid .chat or .sage-chat path under /home/user is required",
    );
  }
  return normalized;
}

export function normalizeProjectChatLimit(limit?: number): number {
  const value = Math.floor(Number(limit ?? DEFAULT_MESSAGE_LIMIT));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(value, MAX_MESSAGE_LIMIT);
}

function maxWindowBytes(limit: number): number {
  return Math.min(
    MAX_WINDOW_BYTES,
    INITIAL_MAX_BYTES + Math.max(0, limit - DEFAULT_MESSAGE_LIMIT) * 16_384,
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${value.slice(0, end)}\n\n[content omitted by CoCalc chat session]`;
}

function boundedMessage(message: ProjectedChatMessage): ProjectedChatMessage {
  const activity = message.activity
    ? {
        ...message.activity,
        events: [],
        markdown: message.activity.markdown
          ? truncateUtf8(message.activity.markdown, MAX_MESSAGE_TEXT_BYTES)
          : undefined,
      }
    : undefined;
  return {
    ...message,
    content: truncateUtf8(message.content, MAX_MESSAGE_TEXT_BYTES),
    acp_events: undefined,
    acp_log_store: undefined,
    acp_log_key: undefined,
    acp_live_log_stream: undefined,
    acp_live_preview_stream: undefined,
    activity,
  };
}

export function boundedProjectChatSnapshot(
  snapshot: ChatSnapshot,
  requestedLimit?: number,
): ChatSnapshot {
  const limit = normalizeProjectChatLimit(requestedLimit);
  const maxBytes = maxWindowBytes(limit);
  const bounded: ProjectedChatMessage[] = [];
  const threads = snapshot.threads.filter(
    ({ thread_id }) => thread_id === snapshot.selected_thread_id,
  );
  let bytes = Buffer.byteLength(JSON.stringify(threads));
  for (
    let index = snapshot.messages.length - 1;
    index >= 0 && bounded.length < limit;
    index -= 1
  ) {
    const message = boundedMessage(snapshot.messages[index]);
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    if (bounded.length > 0 && bytes + messageBytes > maxBytes) break;
    bounded.unshift(message);
    bytes += messageBytes;
  }
  const omitted = Math.max(0, snapshot.messages.length - bounded.length);
  return {
    ...snapshot,
    threads,
    messages: bounded,
    message_window: {
      limit,
      loaded: bounded.length,
      has_older: omitted > 0,
      omitted,
    },
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function projectChatSessionUpdate(
  previous: ChatSnapshot,
  current: ChatSnapshot,
): ProjectChatSessionStreamEvent | undefined {
  const previousMessages = new Map(
    previous.messages.map((message) => [message.message_id, message]),
  );
  const currentIds = new Set(
    current.messages.map(({ message_id }) => message_id),
  );
  const messages = current.messages.filter(
    (message) => !sameJson(previousMessages.get(message.message_id), message),
  );
  const removed_message_ids = previous.messages
    .filter(({ message_id }) => !currentIds.has(message_id))
    .map(({ message_id }) => message_id);
  const threads = sameJson(previous.threads, current.threads)
    ? undefined
    : current.threads;
  const metadataChanged =
    previous.connection !== current.connection ||
    previous.ready !== current.ready ||
    previous.error !== current.error ||
    previous.selected_thread_id !== current.selected_thread_id ||
    !sameJson(previous.message_window, current.message_window);
  if (
    !messages.length &&
    !removed_message_ids.length &&
    !threads &&
    !metadataChanged
  ) {
    return;
  }
  return {
    kind: "update",
    revision: current.revision,
    connection: current.connection,
    ready: current.ready,
    error: current.error,
    selected_thread_id: current.selected_thread_id,
    threads,
    messages,
    removed_message_ids,
    message_window: current.message_window,
  };
}

export async function initProjectChatSessionService(client: Client) {
  const sessions = new Map<string, Session>();

  const closeSession = async (session: Session): Promise<void> => {
    sessions.delete(session.id);
    if (session.updateTimer) clearTimeout(session.updateTimer);
    session.unsubscribe();
    await session.backend.close().catch(() => undefined);
    session.stream.close();
  };

  const pruneSessions = (): void => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.touchedAt > SESSION_IDLE_MS) {
        void closeSession(session);
      }
    }
  };

  const cleanupTimer = setInterval(pruneSessions, 60_000);
  cleanupTimer.unref?.();

  const getSession = (
    subject: string | undefined,
    session_id: unknown,
  ): Session => {
    const identity = parseSubject(subject);
    assertCollaborator(identity);
    const session = sessions.get(`${session_id ?? ""}`);
    if (
      !session ||
      session.account_id !== identity.account_id ||
      session.project_id !== identity.project_id
    ) {
      throw new Error(PROJECT_CHAT_SESSION_NOT_FOUND);
    }
    session.touchedAt = Date.now();
    return session;
  };

  const publishCurrent = (session: Session): void => {
    session.updateTimer = undefined;
    session.publishQueue = session.publishQueue
      .then(async () => {
        const current = boundedProjectChatSnapshot(
          session.backend.getSnapshot(),
          session.limit,
        );
        const event = projectChatSessionUpdate(session.snapshot, current);
        session.snapshot = current;
        if (!event || session.stream.isClosed()) return;
        session.stream.publish(event);
        await session.stream.save();
      })
      .catch((err) => {
        logger.warn("failed to publish project chat session update", {
          session_id: session.id,
          err: `${err}`,
        });
      });
  };

  const schedulePublish = (session: Session): void => {
    if (session.updateTimer) return;
    session.updateTimer = setTimeout(
      () => publishCurrent(session),
      UPDATE_THROTTLE_MS,
    );
  };

  logger.debug("starting project chat session service", {
    subject: PROJECT_CHAT_SESSION_SUBJECT,
  });
  const service = await client.service(PROJECT_CHAT_SESSION_SUBJECT, {
    async open(
      this: { subject?: string },
      opts: {
        path: string;
        selected_thread_id?: string;
        limit?: number;
      },
    ): Promise<ProjectChatSessionOpenResponse> {
      pruneSessions();
      const identity = parseSubject(this.subject);
      assertCollaborator(identity);
      const path = normalizeProjectChatPath(opts?.path);
      const selected_thread_id = `${opts?.selected_thread_id ?? ""}`.trim();
      if (!selected_thread_id) throw new Error("thread id is required");
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort(
          (left, right) => left.touchedAt - right.touchedAt,
        )[0];
        if (oldest) await closeSession(oldest);
      }

      const limit = normalizeProjectChatLimit(opts?.limit);
      const id = randomUUID();
      const stream_name = `project-chat-session-${id}`;
      const backend = createHeadlessChatClient({
        ...identity,
        path,
        projectHostClient: client,
        selected_thread_id,
        activityLoadPolicy: "live-preview-only",
      });
      await backend.open();
      let stream: DStream<ProjectChatSessionStreamEvent> | undefined;
      try {
        stream = await dstream<ProjectChatSessionStreamEvent>({
          project_id: identity.project_id,
          name: stream_name,
          client,
          ephemeral: true,
          noAutosave: true,
          noCache: true,
          noInventory: true,
        });
        await stream.config({
          max_msgs: 100,
          max_bytes: 8 * 1024 * 1024,
          max_age: STREAM_MAX_AGE_MS,
        });
      } catch (err) {
        stream?.close();
        await backend.close().catch(() => undefined);
        throw err;
      }
      const snapshot = boundedProjectChatSnapshot(backend.getSnapshot(), limit);
      const session: Session = {
        ...identity,
        id,
        path,
        limit,
        touchedAt: Date.now(),
        backend,
        stream,
        snapshot,
        unsubscribe: () => undefined,
        publishQueue: Promise.resolve(),
      };
      session.unsubscribe = backend.subscribe((next) => {
        if (next.revision !== session.snapshot.revision)
          schedulePublish(session);
      });
      sessions.set(id, session);
      stream.publish({ kind: "snapshot", snapshot });
      await stream.save();
      return { session_id: id, stream_name, snapshot };
    },

    async send(
      this: { subject?: string },
      opts: { session_id: string; thread_id: string; text: string },
    ) {
      const session = getSession(this.subject, opts?.session_id);
      return await session.backend.sendToExistingCodexThread({
        thread_id: `${opts?.thread_id ?? ""}`,
        text: `${opts?.text ?? ""}`,
      });
    },

    async interrupt(
      this: { subject?: string },
      opts: { session_id: string; thread_id: string },
    ): Promise<null> {
      const session = getSession(this.subject, opts?.session_id);
      await session.backend.interrupt(`${opts?.thread_id ?? ""}`);
      return null;
    },

    async setLimit(
      this: { subject?: string },
      opts: { session_id: string; limit: number },
    ): Promise<ChatSnapshot> {
      const session = getSession(this.subject, opts?.session_id);
      session.limit = normalizeProjectChatLimit(opts?.limit);
      const snapshot = boundedProjectChatSnapshot(
        session.backend.getSnapshot(),
        session.limit,
      );
      session.snapshot = snapshot;
      session.stream.publish({ kind: "snapshot", snapshot });
      await session.stream.save();
      return snapshot;
    },

    selectThread(
      this: { subject?: string },
      opts: { session_id: string; thread_id: string },
    ): null {
      const session = getSession(this.subject, opts?.session_id);
      session.backend.selectThread(`${opts?.thread_id ?? ""}`);
      return null;
    },

    touch(this: { subject?: string }, opts: { session_id: string }): null {
      getSession(this.subject, opts?.session_id);
      return null;
    },

    async close(
      this: { subject?: string },
      opts: { session_id: string },
    ): Promise<null> {
      const session = getSession(this.subject, opts?.session_id);
      await closeSession(session);
      return null;
    },
  });

  return {
    close(): void {
      clearInterval(cleanupTimer);
      service.close();
      for (const session of sessions.values()) void closeSession(session);
    },
  };
}
