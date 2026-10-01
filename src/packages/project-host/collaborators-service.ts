/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  createHumanThread,
  humanRoomMarker,
  initializeHumanRoom,
  sendHumanMessage,
} from "@cocalc/chat";
import type { HumanRoomSyncDB } from "@cocalc/chat";
import type { Client } from "@cocalc/conat/core/client";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { type CollaborationRoom } from "@cocalc/util/collaborators";
import { validateCollaborationRoomReplacementRequest } from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementAbsence,
  CollaborationRoomReplacementRequest,
  CollaborationRoomReplacementResult,
  CollaborationRoomServiceState,
} from "@cocalc/util/collaboration-room-replacement";
import { replaceCanonicalRoom } from "@cocalc/backend/collaborators/room-replacement";
import { getLocalHostId } from "./sqlite/hosts";
import {
  assertInitializedRoomSource,
  ensureUninitializedRoomParent,
  getCollaboratorsService,
  withRoomReplacementFilesystem,
} from "./collaborators";
import { getProject } from "./sqlite/projects";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
} from "./project-volume-lifecycle";

export const COLLABORATORS_SERVICE = "collaborators";
export const COLLABORATORS_SUBJECT = `services.*.*.*.*.${COLLABORATORS_SERVICE}`;
interface Identity {
  account_id: string;
  project_id: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function collaborationServiceIdentity(subject?: string): Identity {
  const parts = `${subject ?? ""}`.split(".");
  const account_id = parts[1]?.startsWith("account-") ? parts[1].slice(8) : "";
  const project_id = parts[3];
  if (
    parts.length !== 6 ||
    parts[0] !== "services" ||
    parts[5] !== COLLABORATORS_SERVICE ||
    !UUID.test(account_id) ||
    !UUID.test(project_id ?? "")
  )
    throw Error("authenticated account collaboration subject required");
  return { account_id, project_id };
}

function authorize(identity: Identity) {
  const local = getProject(identity.project_id);
  const project = getRow(
    "projects",
    JSON.stringify({ project_id: identity.project_id }),
  );
  const entry = project?.users?.[identity.account_id];
  if (
    !local ||
    local.local_only ||
    !isProjectCollaboratorGroup(
      typeof entry === "string" ? entry : entry?.group,
    )
  )
    throw Error("project collaborator access required");
}

function authorizeReplacement(identity: Identity) {
  authorize(identity);
  const entry = getRow(
    "projects",
    JSON.stringify({ project_id: identity.project_id }),
  )?.users?.[identity.account_id];
  if ((typeof entry === "string" ? entry : entry?.group) !== "owner")
    throw Error("canonical room replacement requires project owner access");
}

/** Stable retry IDs are namespaced by actor, room, operation and operation kind. */
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

/**
 * The owner-routed, host-authorized metadata resolver must
 * verify room registration and current membership, not impersonate an account
 * on the hub bus. Normal chat authorization remains on the project data plane.
 */
export async function initCollaboratorsService(
  client: Client,
  options: {
    resolveRoom(
      identity: Identity,
      request_id: string,
    ): Promise<CollaborationRoomServiceState>;
    markInitialized(
      room: CollaborationRoom,
      identity: Identity,
    ): Promise<CollaborationRoom>;
    replaceRoom(
      identity: Identity,
      request: CollaborationRoomReplacementRequest,
      absence?: CollaborationRoomReplacementAbsence,
    ): Promise<CollaborationRoomReplacementResult>;
    sourceEpoch(source: {
      project_id: string;
      chat_path: string;
    }): Promise<string | null>;
  },
) {
  const active = new Map<string, Promise<unknown>>();
  let closed = false;
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
    authorize(identity);
    if (!UUID.test(request_id)) throw Error("valid request_id required");
    if (!UUID.test(expected_room_id ?? ""))
      throw Error("valid expected_room_id required");
    if (
      !reserved &&
      (closed || active.size >= 32 || active.has(identity.project_id))
    )
      throw Error("human room service busy; retry the same request_id");
    const task = (async () => {
      const room = await options.resolveRoom(identity, request_id);
      if (
        !room ||
        room.project_id !== identity.project_id ||
        typeof room.chat_path !== "string" ||
        !room.chat_path.startsWith("/home/user/") ||
        room.chat_path.length > 4096 ||
        posix.normalize(room.chat_path) !== room.chat_path ||
        !/\.chat$/.test(room.chat_path) ||
        !UUID.test(room.room_id)
      )
        throw Error("existing canonical room registration required");
      if (room.room_id !== expected_room_id)
        throw Error("canonical room changed; stale human operation rejected");
      authorize(identity);
      const journal = getCollaboratorsService().journal;
      if (room.retired_rooms?.length) journal.reconcileRoom(room);
      const initialized =
        room.initialized || journal.roomState(room.project_id, room.room_id);
      if (initialized) await assertInitializedRoomSource(room);
      else await ensureUninitializedRoomParent(room);
      const db = await acquireChatSyncDB({
        client,
        project_id: room.project_id,
        path: room.chat_path,
        readyTimeoutMs: 30_000,
      });
      try {
        authorize(identity);
        if (initialized && !humanRoomMarker(db, room))
          throw Error(
            "human room was deleted; explicit restore or replacement required",
          );
        const existingMarker = humanRoomMarker(db, room);
        const source = {
          project_id: room.project_id,
          chat_path: room.chat_path,
        };
        const generation = currentProjectVolumeLifecycleGeneration(
          room.project_id,
        );
        if (!initialized && !existingMarker && db.get().length === 0)
          journal.beginRoomInitialization(source, room.room_id, generation);
        await initializeHumanRoom(db, room);
        assertProjectVolumeLifecycleGeneration(room.project_id, generation);
        if (
          !initialized &&
          journal.pendingRoomInitialization(source, room.room_id, generation)
        )
          journal.armNotifications(source, room.room_id, generation);
        journal.initializedRoom(room.project_id, room.room_id);
        const registered = await options.markInitialized(room, identity);
        if (
          registered.project_id !== room.project_id ||
          registered.room_id !== room.room_id ||
          registered.chat_path !== room.chat_path ||
          registered.initialized !== true
        )
          throw Error(
            "human room initialization was not confirmed by its owner",
          );
        authorize(identity);
        return await mutate(db, registered, identity);
      } finally {
        await releaseChatSyncDB(room.project_id, room.chat_path);
      }
    })();
    if (!reserved) active.set(identity.project_id, task);
    try {
      return await task;
    } finally {
      if (!reserved) active.delete(identity.project_id);
    }
  }
  const service = await client.service(COLLABORATORS_SUBJECT, {
    async replaceRoom(
      this: { subject?: string },
      value: CollaborationRoomReplacementRequest,
    ) {
      const request = validateCollaborationRoomReplacementRequest(value);
      const identity = collaborationServiceIdentity(this.subject);
      authorizeReplacement(identity);
      if (request.project_id !== identity.project_id)
        throw Error("replacement project identity mismatch");
      if (closed || active.size >= 32 || active.has(identity.project_id))
        throw Error("human room service busy; retry the same request_id");
      const subject = this.subject;
      const task = Promise.resolve().then(async () => {
        const host_id = getLocalHostId();
        if (!host_id) throw Error("local host identity unavailable");
        const result = await withRoomReplacementFilesystem(
          request,
          (fs, assertLifecycle) =>
            replaceCanonicalRoom({
              request,
              identity,
              host_id,
              assertCurrent: () => {
                authorizeReplacement(identity);
                assertLifecycle();
              },
              withSourceLock: (run) => run(),
              currentRoom: () =>
                options.resolveRoom(identity, request.request_id),
              sourceEpoch: () =>
                options.sourceEpoch({
                  project_id: request.project_id,
                  chat_path: request.expected_chat_path,
                }),
              lstat: () => fs.lstat(request.expected_chat_path),
              commit: (absence) =>
                options.replaceRoom(identity, request, absence),
              transition: (previous, next) =>
                getCollaboratorsService().journal.replaceRoom(previous, next),
            }),
        );
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
      active.set(identity.project_id, task);
      try {
        return await task;
      } finally {
        active.delete(identity.project_id);
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
      await Promise.allSettled([...active.values()]);
    },
  };
}
