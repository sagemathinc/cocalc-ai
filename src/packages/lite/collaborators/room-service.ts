/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  createHumanThread,
  humanRoomMarker,
  initializeHumanRoom,
  sendHumanMessage,
} from "@cocalc/chat";
import type { HumanRoomSyncDB } from "@cocalc/chat";
import type { Client } from "@cocalc/conat/core/client";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { validateCollaborationRoomReplacementRequest } from "@cocalc/util/collaboration-room-replacement";
import type { CollaborationRoomReplacementRequest } from "@cocalc/util/collaboration-room-replacement";
import type { CollaborationRoomServiceState } from "@cocalc/util/collaboration-room-replacement";
import type { createLiteCollaborators } from "./service";

// Same wire protocol as project-host/collaborators-service, without depending on
// project-host authorization, globals, storage or lifecycle in standalone Lite.
export const COLLABORATORS_SUBJECT = "services.*.*.*.*.collaborators";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Identity {
  account_id: string;
  project_id: string;
}
type Runtime = Pick<
  ReturnType<typeof createLiteCollaborators>,
  | "store"
  | "assertInitializedRoomSource"
  | "ensureRoomDirectory"
  | "replaceRoom"
> & {
  service: Pick<
    ReturnType<typeof createLiteCollaborators>["service"],
    "journal"
  >;
};

export function collaborationServiceIdentity(subject?: string): Identity {
  const parts = `${subject ?? ""}`.split(".");
  const account_id = parts[1]?.startsWith("account-") ? parts[1].slice(8) : "";
  const project_id = parts[3];
  if (
    parts.length !== 6 ||
    parts[0] !== "services" ||
    parts[5] !== "collaborators" ||
    !UUID.test(account_id) ||
    !UUID.test(project_id ?? "")
  )
    throw Error("authenticated account collaboration subject required");
  return { account_id, project_id };
}

/** Byte-for-byte the host protocol's actor/room/operation retry identity. */
export function humanOperationId(
  identity: Identity,
  room_id: string,
  operation: "thread" | "message",
  request_id: string,
): string {
  if (!UUID.test(request_id)) throw Error("valid request_id required");
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        identity.project_id,
        identity.account_id,
        room_id,
        operation,
        request_id,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function initLiteCollaboratorsRoomService(
  client: Client,
  runtime: Runtime,
) {
  let closed = false;
  let active: Promise<unknown> | undefined;

  async function authorize(
    identity: Identity,
    expected?: CollaborationRoom,
  ): Promise<CollaborationRoomServiceState> {
    // The store checks both local identities and the current feature flag.
    const room = await runtime.store.roomForService(identity);
    if (
      !room ||
      !UUID.test(room.room_id) ||
      room.project_id !== identity.project_id
    )
      throw Error("existing canonical room registration required");
    if (
      expected &&
      (room.room_id !== expected.room_id ||
        room.chat_path !== expected.chat_path)
    )
      throw Error("human room registration changed");
    return room;
  }

  async function run<T>(
    subject: string | undefined,
    request_id: string,
    expected_room_id: string,
    mutate: (
      db: HumanRoomSyncDB,
      room: CollaborationRoom,
      identity: Identity,
    ) => Promise<T>,
    reserved = false,
  ): Promise<T> {
    const identity = collaborationServiceIdentity(subject);
    if (!UUID.test(request_id)) throw Error("valid request_id required");
    if (!UUID.test(expected_room_id ?? ""))
      throw Error("valid expected_room_id required");
    if (!reserved && (closed || active))
      throw Error("human room service busy; retry the same request_id");
    // Reserve before the first async authorization, with no queued requests.
    const task = Promise.resolve().then(async () => {
      const room = await authorize(identity);
      if (room.room_id !== expected_room_id)
        throw Error("canonical room changed; stale human operation rejected");
      const journal = runtime.service.journal;
      if (room.retired_rooms?.length) journal.reconcileRoom(room);
      const initialized =
        room.initialized || journal.roomState(room.project_id, room.room_id);
      if (initialized) await runtime.assertInitializedRoomSource(room);
      await authorize(identity, room);
      if (!initialized) await runtime.ensureRoomDirectory(room);
      await authorize(identity, room);
      const db = await acquireChatSyncDB({
        client,
        project_id: room.project_id,
        path: room.chat_path,
        readyTimeoutMs: 30_000,
      });
      try {
        await authorize(identity, room);
        if (initialized && !humanRoomMarker(db, room))
          throw Error(
            "human room was deleted; explicit restore or replacement required",
          );
        await initializeHumanRoom(db, room);
        // Safe on a lost-save-ack retry too. Never arm an adopted room's history.
        if (db.get().every((row) => row.event === "collaborators-room"))
          journal.armNotifications(
            { project_id: room.project_id, chat_path: room.chat_path },
            room.room_id,
          );
        journal.initializedRoom(room.project_id, room.room_id);
        await runtime.store.markRoomInitialized({
          project_id: room.project_id,
          room_id: room.room_id,
          chat_path: room.chat_path,
          requesting_account_id: identity.account_id,
        });
        await authorize(identity, room);
        return await mutate(db, { ...room, initialized: true }, identity);
      } finally {
        await releaseChatSyncDB(room.project_id, room.chat_path);
      }
    });
    if (!reserved) active = task;
    try {
      return await task;
    } finally {
      if (active === task) active = undefined;
    }
  }

  const service = await client.service(COLLABORATORS_SUBJECT, {
    async replaceRoom(
      this: { subject?: string },
      value: CollaborationRoomReplacementRequest,
    ) {
      const request = validateCollaborationRoomReplacementRequest(value);
      const identity = collaborationServiceIdentity(this.subject);
      if (request.project_id !== identity.project_id)
        throw Error("replacement project identity mismatch");
      if (closed || active)
        throw Error("human room service busy; retry the same request_id");
      const subject = this.subject;
      const task = Promise.resolve().then(async () => {
        await authorize(identity);
        const result = await runtime.replaceRoom(request, identity);
        if (result.outcome === "superseded") return result;
        const room = await run(
          subject,
          request.request_id,
          result.room.room_id,
          async (_db, room) => room,
          true,
        );
        return {
          outcome: "ready" as const,
          operation_id: result.operation_id,
          room: { ...room, initialized: true },
        };
      });
      active = task;
      try {
        return await task;
      } finally {
        if (active === task) active = undefined;
      }
    },
    initialize(
      this: { subject?: string },
      opts: { request_id: string; expected_room_id: string },
    ) {
      return run(
        this.subject,
        opts?.request_id,
        opts?.expected_room_id,
        async (_db, room) => room,
      );
    },
    createThread(
      this: { subject?: string },
      opts: { request_id: string; expected_room_id: string; title?: string },
    ) {
      if (
        opts?.title != null &&
        (typeof opts.title !== "string" || opts.title.length > 512)
      )
        throw Error("invalid human thread title");
      return run(
        this.subject,
        opts?.request_id,
        opts?.expected_room_id,
        async (db, room, identity) =>
          createHumanThread(db, {
            room,
            account_id: identity.account_id,
            thread_id: humanOperationId(
              identity,
              room.room_id,
              "thread",
              opts.request_id,
            ),
            title: opts.title,
          }),
      );
    },
    send(
      this: { subject?: string },
      opts: {
        request_id: string;
        expected_room_id: string;
        thread_id: string;
        text: string;
      },
    ) {
      if (!UUID.test(opts?.thread_id ?? ""))
        throw Error("valid thread_id required");
      if (
        typeof opts?.text !== "string" ||
        !opts.text.trim() ||
        opts.text.length > 32768
      )
        throw Error("human message must contain 1 to 32768 characters");
      return run(
        this.subject,
        opts?.request_id,
        opts?.expected_room_id,
        async (db, room, identity) =>
          sendHumanMessage(db, {
            room,
            account_id: identity.account_id,
            thread_id: opts.thread_id,
            message_id: humanOperationId(
              identity,
              room.room_id,
              "message",
              opts.request_id,
            ),
            text: opts.text,
          }),
      );
    },
  });
  return {
    async close() {
      closed = true;
      service.close();
      if (active) await Promise.allSettled([active]);
    },
  };
}
