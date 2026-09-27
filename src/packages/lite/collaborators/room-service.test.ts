/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { LiteCollaborators } from "./index";
import {
  collaborationServiceIdentity,
  humanOperationId,
  initLiteCollaboratorsRoomService,
  COLLABORATORS_SUBJECT,
} from "./room-service";
import type { Client } from "@cocalc/conat/core/client";
import type { CollaborationRoom } from "@cocalc/util/collaborators";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));

const identity = {
  account_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
};
const request_id = "44444444-4444-4444-8444-444444444444";
const subject = `services.account-${identity.account_id}._.${identity.project_id}._.collaborators`;
let enabled: boolean;
let store: LiteCollaborators;
let journal: CollaborationJournal;
let room: CollaborationRoom;
let rows: Record<string, any>[];
let handlers: any;
let service: Awaited<ReturnType<typeof initLiteCollaboratorsRoomService>>;
let diskExists: boolean;
const db = {
  get: () => rows,
  set: jest.fn((row) => {
    rows.push(row);
  }),
  commit: jest.fn(),
  save: jest.fn(),
  save_to_disk: jest.fn(),
};

beforeEach(async () => {
  jest.clearAllMocks();
  rows = [];
  enabled = true;
  diskExists = true;
  store = new LiteCollaborators({
    filename: ":memory:",
    ...identity,
    isEnabled: () => enabled,
  });
  room = await store.ensureRoom({ ...identity, request_id });
  journal = new CollaborationJournal(":memory:");
  jest.mocked(acquireChatSyncDB).mockResolvedValue(db as any);
  jest.mocked(releaseChatSyncDB).mockResolvedValue(undefined);
  db.save.mockResolvedValue(undefined);
  db.save_to_disk.mockResolvedValue(undefined);
  const client = {
    service: jest.fn(async (wireSubject, methods) => {
      expect(wireSubject).toBe(COLLABORATORS_SUBJECT);
      handlers = methods;
      return { close: jest.fn() };
    }),
  };
  service = await initLiteCollaboratorsRoomService(
    client as unknown as Client,
    {
      store,
      service: { journal },
      ensureRoomDirectory: async () => {},
      assertInitializedRoomSource: async () => {
        if (!diskExists) throw Error("human room was deleted or replaced");
      },
    } as Parameters<typeof initLiteCollaboratorsRoomService>[1],
  );
});

afterEach(async () => {
  await service.close();
  journal.close();
  store.close();
});

test("subject and operation IDs match the host protocol", () => {
  expect(collaborationServiceIdentity(subject)).toEqual(identity);
  expect(() =>
    collaborationServiceIdentity(subject.replace("account-", "agent-")),
  ).toThrow("authenticated account");
  expect(
    humanOperationId(
      identity,
      "33333333-3333-4333-8333-333333333333",
      "thread",
      request_id,
    ),
  ).toBe("411a7b59-49a5-58a5-a66d-b727af71f13e");
  expect(
    humanOperationId(identity, room.room_id, "thread", request_id),
  ).not.toBe(humanOperationId(identity, room.room_id, "message", request_id));
});

test("create/send retries retain a single human thread/message and ignore spoofed payload actors", async () => {
  const create = { request_id, title: "Seminar", account_id: "spoofed" };
  const a = await handlers.createThread.call({ subject }, create);
  const b = await handlers.createThread.call({ subject }, create);
  expect(a).toEqual(b);
  expect(rows.filter((row) => row.event === "chat-thread")).toHaveLength(1);
  const config = rows.find((row) => row.event === "chat-thread-config");
  expect(config).toMatchObject({ agent_kind: "none", thread_id: a.thread_id });
  expect(config?.acp_config).toBeUndefined();
  expect(rows.find((row) => row.event === "chat-thread")?.created_by).toBe(
    identity.account_id,
  );
  const send = {
    request_id,
    thread_id: a.thread_id,
    text: "@codex is a reference, not an invocation",
    account_id: "spoofed",
  };
  expect(await handlers.send.call({ subject }, send)).toEqual(
    await handlers.send.call({ subject }, send),
  );
  expect(rows.filter((row) => row.event === "chat")).toHaveLength(1);
  expect(rows.find((row) => row.event === "chat")?.sender_id).toBe(
    identity.account_id,
  );
  expect(journal.roomState(identity.project_id, room.room_id)).toBe(true);
  expect(releaseChatSyncDB).toHaveBeenCalledTimes(4);
});

test.each([
  subject.replace(identity.account_id, "55555555-5555-4555-8555-555555555555"),
  subject.replace(identity.project_id, "55555555-5555-4555-8555-555555555555"),
  subject.replace("account-", "project-"),
])(
  "strangers and non-account principals cannot initialize: %s",
  async (foreign) => {
    await expect(
      handlers.initialize.call(
        { subject: foreign },
        { request_id, ...identity },
      ),
    ).rejects.toThrow();
    expect(acquireChatSyncDB).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  },
);

test("every operation observes the current feature flag", async () => {
  enabled = false;
  for (const [method, opts] of [
    ["initialize", { request_id }],
    ["createThread", { request_id, title: "No" }],
    ["send", { request_id, thread_id: request_id, text: "No" }],
  ] as const)
    await expect(handlers[method].call({ subject }, opts)).rejects.toThrow(
      "disabled",
    );
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  enabled = true;
  expect(await handlers.initialize.call({ subject }, { request_id })).toEqual({
    ...room,
    initialized: true,
  });
});

test("disabled during acquisition releases the source before initialization or mutation", async () => {
  jest.mocked(acquireChatSyncDB).mockImplementationOnce(async () => {
    enabled = false;
    return db as any;
  });
  await expect(
    handlers.createThread.call({ subject }, { request_id }),
  ).rejects.toThrow("disabled");
  expect(rows).toEqual([]);
  expect(releaseChatSyncDB).toHaveBeenCalledTimes(1);
});

test("missing registration cannot allocate a room", async () => {
  const lookup = jest
    .spyOn(store, "registeredRoom")
    .mockResolvedValueOnce(null);
  const ensure = jest.spyOn(store, "ensureRoom");
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("existing canonical room");
  expect(ensure).not.toHaveBeenCalled();
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  lookup.mockRestore();
});

test("initialized source deletion is checked before opening a cached SyncDB", async () => {
  await handlers.initialize.call({ subject }, { request_id });
  diskExists = false;
  jest.mocked(acquireChatSyncDB).mockClear();
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("deleted");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});

test("owner initialized guard survives losing the worker journal", async () => {
  await handlers.initialize.call({ subject }, { request_id });
  expect((await store.registeredRoom(identity))?.initialized).toBe(true);
  jest.spyOn(journal, "roomState").mockReturnValue(false);
  diskExists = false;
  jest.mocked(acquireChatSyncDB).mockClear();
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("deleted");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});

test("missing live marker in an initialized room cannot silently recreate it", async () => {
  await handlers.initialize.call({ subject }, { request_id });
  rows = [];
  await expect(
    handlers.createThread.call({ subject }, { request_id }),
  ).rejects.toThrow("deleted");
  expect(rows).toEqual([]);
});

test("failed disk acknowledgment retries initialization rather than claiming completion", async () => {
  const arm = jest.spyOn(journal, "armNotifications");
  db.save_to_disk.mockRejectedValueOnce(Error("lost disk acknowledgment"));
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("disk acknowledgment");
  expect(journal.roomState(identity.project_id, room.room_id)).toBe(false);
  expect(arm).not.toHaveBeenCalled();
  await handlers.initialize.call({ subject }, { request_id });
  expect(arm).toHaveBeenCalledWith(
    { project_id: room.project_id, chat_path: room.chat_path },
    room.room_id,
  );
  expect(journal.roomState(identity.project_id, room.room_id)).toBe(true);
  expect(rows.filter((row) => row.event === "collaborators-room")).toHaveLength(
    1,
  );
});

test("arming does not reinterpret an existing thread's history as live", async () => {
  await handlers.createThread.call({ subject }, { request_id });
  const arm = jest.spyOn(journal, "armNotifications");
  await handlers.initialize.call({ subject }, { request_id });
  expect(arm).not.toHaveBeenCalled();
});

test("non-waiting admission rejects concurrent operations before any I/O", async () => {
  const first = handlers.initialize.call({ subject }, { request_id });
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("busy");
  await first;
  await service.close();
  await expect(
    handlers.initialize.call({ subject }, { request_id }),
  ).rejects.toThrow("busy");
});
