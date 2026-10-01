import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  createHumanThread,
  humanRoomMarker,
  initializeHumanRoom,
  sendHumanMessage,
} from "@cocalc/chat";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import {
  assertInitializedRoomSource,
  ensureUninitializedRoomParent,
  withRoomReplacementFilesystem,
} from "./collaborators";
import {
  collaborationServiceIdentity,
  humanOperationId,
  initCollaboratorsService,
} from "./collaborators-service";
import { collaborationRoomReplacementOperationId } from "@cocalc/util/collaboration-room-replacement";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));
jest.mock("@cocalc/chat", () => ({
  createHumanThread: jest.fn(),
  humanRoomMarker: jest.fn(),
  initializeHumanRoom: jest.fn(),
  sendHumanMessage: jest.fn(),
}));
jest.mock("@cocalc/lite/hub/sqlite/database", () => ({ getRow: jest.fn() }), {
  virtual: true,
});
jest.mock("./sqlite/projects", () => ({
  getProject: jest.fn(() => ({ local_only: false })),
}));
jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: () => "55555555-5555-4555-8555-555555555555",
}));
const journal = {
  roomState: jest.fn(),
  initializedRoom: jest.fn(),
  armNotifications: jest.fn(),
  beginRoomInitialization: jest.fn(),
  pendingRoomInitialization: jest.fn(),
  replaceRoom: jest.fn(),
  reconcileRoom: jest.fn(),
};
jest.mock("./collaborators", () => ({
  getCollaboratorsService: () => ({ journal }),
  assertInitializedRoomSource: jest.fn(),
  ensureUninitializedRoomParent: jest.fn(),
  withRoomReplacementFilesystem: jest.fn(),
}));
const identity = {
  account_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
};
const room = {
  project_id: identity.project_id,
  room_id: "33333333-3333-4333-8333-333333333333",
  chat_path: "/home/user/.cocalc/collaborators.chat",
};
const request_id = "44444444-4444-4444-8444-444444444444";
const subject = `services.account-${identity.account_id}.browser.${identity.project_id}.0.collaborators`;
const db = {
  get: jest.fn(() => []),
  set: jest.fn(),
  commit: jest.fn(),
  save: jest.fn(),
  save_to_disk: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
  (getRow as jest.Mock).mockReturnValue({
    users: { [identity.account_id]: { group: "collaborator" } },
  });
  (acquireChatSyncDB as jest.Mock).mockResolvedValue(db);
  (humanRoomMarker as jest.Mock).mockReturnValue(true);
  (assertInitializedRoomSource as jest.Mock).mockResolvedValue(undefined);
  journal.roomState.mockReturnValue(false);
  journal.pendingRoomInitialization.mockReturnValue(false);
  journal.beginRoomInitialization.mockImplementation(() => {
    journal.pendingRoomInitialization.mockReturnValue(true);
  });
  journal.initializedRoom.mockImplementation(() => {
    journal.roomState.mockReturnValue(true);
    journal.pendingRoomInitialization.mockReturnValue(false);
  });
  (ensureUninitializedRoomParent as jest.Mock).mockResolvedValue(undefined);
  (initializeHumanRoom as jest.Mock).mockResolvedValue(undefined);
});
async function setup() {
  let handlers: any;
  const client = {
    service: jest.fn(async (_subject, methods) => {
      handlers = methods;
      return { close: jest.fn() };
    }),
  };
  const resolveRoom = jest.fn(async () => ({ ...room, initialized: false }));
  const markInitialized = jest.fn(async (value) => ({
    ...value,
    initialized: true,
  }));
  const replaceRoom = jest.fn();
  const sourceEpoch = jest.fn(async () => null);
  const service = await initCollaboratorsService(client as any, {
    resolveRoom,
    markInitialized,
    replaceRoom,
    sourceEpoch,
  });
  return {
    handlers,
    resolveRoom,
    markInitialized,
    replaceRoom,
    sourceEpoch,
    service,
  };
}

const replacementRequest = {
  version: 1 as const,
  project_id: room.project_id,
  request_id,
  expected_room_id: room.room_id,
  expected_chat_path: room.chat_path,
};
const replacement = {
  ...room,
  room_id: "66666666-6666-4666-8666-666666666666",
  chat_path: "/home/user/.cocalc/conversations/new.chat",
  initialized: false,
};
const operation_id = collaborationRoomReplacementOperationId(
  room.project_id,
  identity.account_id,
  request_id,
);
function replacementFixture() {
  (getRow as jest.Mock).mockReturnValue({
    users: { [identity.account_id]: { group: "owner" } },
  });
  const lstat = jest.fn(async () => {
    throw Object.assign(Error("missing"), { code: "ENOENT" });
  });
  (withRoomReplacementFilesystem as jest.Mock).mockImplementation(
    async (_request, run) => run({ lstat }, () => {}),
  );
  return { lstat };
}

test("replacement is owner-only and stale ordinary operations fail before opening SyncDB", async () => {
  const { handlers, replaceRoom, service } = await setup();
  await expect(
    handlers.replaceRoom.call({ subject }, replacementRequest),
  ).rejects.toThrow("owner");
  expect(withRoomReplacementFilesystem).not.toHaveBeenCalled();
  expect(replaceRoom).not.toHaveBeenCalled();
  for (const method of ["initialize", "createThread", "send"])
    await expect(
      handlers[method].call(
        { subject },
        {
          request_id,
          expected_room_id: replacement.room_id,
          thread_id: request_id,
          text: "stale",
        },
      ),
    ).rejects.toThrow("stale");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await service.close();
});

test("confirmed absence commits before normal SyncDB initialization and does not create a thread", async () => {
  const { handlers, resolveRoom, replaceRoom, service } = await setup();
  const { lstat } = replacementFixture();
  resolveRoom
    .mockResolvedValueOnce({ ...room, initialized: true })
    .mockResolvedValue(replacement);
  replaceRoom.mockResolvedValue({
    outcome: "pending",
    operation_id,
    room: replacement,
  });
  const result = await handlers.replaceRoom.call(
    { subject },
    replacementRequest,
  );
  expect(result).toEqual({
    outcome: "ready",
    operation_id,
    room: { ...replacement, initialized: true },
  });
  expect(lstat).toHaveBeenCalledTimes(1);
  expect(replaceRoom).toHaveBeenCalledWith(
    identity,
    replacementRequest,
    expect.objectContaining({
      status: "missing",
      requesting_account_id: identity.account_id,
      host_id: "55555555-5555-4555-8555-555555555555",
      source_epoch: null,
    }),
  );
  expect(journal.replaceRoom).toHaveBeenCalledWith(
    { ...room, initialized: true },
    replacement,
  );
  expect(replaceRoom.mock.invocationCallOrder[0]).toBeLessThan(
    (acquireChatSyncDB as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(createHumanThread).not.toHaveBeenCalled();
  expect(sendHumanMessage).not.toHaveBeenCalled();
  await service.close();
});

test.each(["EACCES", "EIO", "exists"])(
  "replacement never interprets %s as absence",
  async (failure) => {
    const { handlers, resolveRoom, replaceRoom, service } = await setup();
    const { lstat } = replacementFixture();
    resolveRoom.mockResolvedValue({ ...room, initialized: true });
    if (failure === "exists") lstat.mockResolvedValue(undefined as never);
    else
      lstat.mockRejectedValue(Object.assign(Error(failure), { code: failure }));
    await expect(
      handlers.replaceRoom.call({ subject }, replacementRequest),
    ).rejects.toThrow(failure === "exists" ? "still exists" : failure);
    expect(replaceRoom).not.toHaveBeenCalled();
    expect(acquireChatSyncDB).not.toHaveBeenCalled();
    await service.close();
  },
);

test("lost owner acknowledgement replays without inspecting or initializing the retired path", async () => {
  const { handlers, resolveRoom, replaceRoom, service } = await setup();
  const { lstat } = replacementFixture();
  resolveRoom.mockResolvedValue({ ...room, initialized: true });
  replaceRoom
    .mockImplementationOnce(async () => {
      resolveRoom.mockResolvedValue(replacement);
      throw Error("owner acknowledgement lost");
    })
    .mockResolvedValue({ outcome: "pending", operation_id, room: replacement });
  await expect(
    handlers.replaceRoom.call({ subject }, replacementRequest),
  ).rejects.toThrow("acknowledgement lost");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await expect(
    handlers.replaceRoom.call({ subject }, replacementRequest),
  ).resolves.toMatchObject({ outcome: "ready" });
  expect(lstat).toHaveBeenCalledTimes(1);
  expect(replaceRoom.mock.calls[1][2]).toBeUndefined();
  expect(acquireChatSyncDB).toHaveBeenCalledWith(
    expect.objectContaining({ path: replacement.chat_path }),
  );
  await service.close();
});

test("a superseded receipt never initializes or mutates a room", async () => {
  const { handlers, resolveRoom, replaceRoom, service } = await setup();
  const { lstat } = replacementFixture();
  resolveRoom.mockResolvedValue(replacement);
  const result = {
    outcome: "superseded",
    operation_id,
    replacement_room_id: replacement.room_id,
  };
  replaceRoom.mockResolvedValue(result);
  await expect(
    handlers.replaceRoom.call({ subject }, replacementRequest),
  ).resolves.toEqual(result);
  expect(lstat).not.toHaveBeenCalled();
  expect(journal.replaceRoom).not.toHaveBeenCalled();
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await service.close();
});

test("pending replacement retries reject a corrupt destination before opening SyncDB", async () => {
  const { handlers, resolveRoom, replaceRoom, markInitialized, service } =
    await setup();
  replacementFixture();
  resolveRoom.mockResolvedValue(replacement);
  replaceRoom.mockResolvedValue({
    outcome: "pending",
    operation_id,
    room: replacement,
  });
  (ensureUninitializedRoomParent as jest.Mock).mockRejectedValue(
    SyntaxError("invalid JSONL"),
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      handlers.replaceRoom.call({ subject }, replacementRequest),
    ).rejects.toThrow("invalid JSONL");
  expect(ensureUninitializedRoomParent).toHaveBeenCalledWith(replacement);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(initializeHumanRoom).not.toHaveBeenCalled();
  expect(markInitialized).not.toHaveBeenCalled();
  expect(journal.armNotifications).not.toHaveBeenCalled();
  await service.close();
});

test("replacement reserves non-waiting admission before filesystem work", async () => {
  const { handlers, service } = await setup();
  replacementFixture();
  (withRoomReplacementFilesystem as jest.Mock).mockRejectedValue(
    Error("filesystem unavailable"),
  );
  const first = handlers.replaceRoom.call({ subject }, replacementRequest);
  await expect(
    handlers.initialize.call(
      { subject },
      { request_id, expected_room_id: room.room_id },
    ),
  ).rejects.toThrow("busy");
  await expect(
    handlers.replaceRoom.call({ subject }, replacementRequest),
  ).rejects.toThrow("busy");
  await expect(first).rejects.toThrow("filesystem unavailable");
  await service.close();
});

test("subject requires an account identity and cannot substitute an account in the payload", () => {
  expect(collaborationServiceIdentity(subject)).toEqual(identity);
  expect(() =>
    collaborationServiceIdentity(subject.replace("account-", "project-")),
  ).toThrow(/account/);
  expect(humanOperationId(identity, room.room_id, "thread", request_id)).toBe(
    humanOperationId(identity, room.room_id, "thread", request_id),
  );
  expect(
    humanOperationId(identity, room.room_id, "thread", request_id),
  ).not.toBe(humanOperationId(identity, room.room_id, "message", request_id));
});
test("file-only viewer is rejected before owner lookup or any chat creation", async () => {
  const { handlers, resolveRoom, service } = await setup();
  (getRow as jest.Mock).mockReturnValue({
    users: { [identity.account_id]: { group: "viewer" } },
  });
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow(/collaborator/);
  expect(resolveRoom).not.toHaveBeenCalled();
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await service.close();
});
test("missing registered room fails without touching SyncDB and never calls ensureRoom", async () => {
  const { handlers, resolveRoom, service } = await setup();
  resolveRoom.mockResolvedValueOnce(null as any);
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow(/existing canonical/);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await service.close();
});
test("create and send use human-only helpers with bound actor and stable operation IDs", async () => {
  const { handlers, resolveRoom, service } = await setup();
  await handlers.createThread.call(
    { subject },
    {
      expected_room_id: room.room_id,
      request_id,
      title: "Discussion",
      account_id: "spoofed",
    },
  );
  expect(resolveRoom).toHaveBeenCalledWith(identity, request_id);
  expect(createHumanThread).toHaveBeenCalledWith(db, {
    room: { ...room, initialized: true },
    account_id: identity.account_id,
    title: "Discussion",
    thread_id: humanOperationId(identity, room.room_id, "thread", request_id),
  });
  await handlers.send.call(
    { subject },
    {
      expected_room_id: room.room_id,
      request_id,
      thread_id: request_id,
      text: "@codex is a reference",
    },
  );
  expect(sendHumanMessage).toHaveBeenCalledWith(
    db,
    expect.objectContaining({
      account_id: identity.account_id,
      text: "@codex is a reference",
      message_id: humanOperationId(
        identity,
        room.room_id,
        "message",
        request_id,
      ),
    }),
  );
  expect(releaseChatSyncDB).toHaveBeenCalledTimes(2);
  await service.close();
});
test("deleted initialized room is not opened or recreated", async () => {
  const { handlers, service } = await setup();
  journal.roomState.mockReturnValue(true);
  (assertInitializedRoomSource as jest.Mock).mockRejectedValueOnce(
    Error("deleted room"),
  );
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow(/deleted/);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(initializeHumanRoom).not.toHaveBeenCalled();
  expect(ensureUninitializedRoomParent).not.toHaveBeenCalled();
  await service.close();
});

test("owner initialization guard survives losing the host-private journal", async () => {
  const { handlers, resolveRoom, service } = await setup();
  resolveRoom.mockResolvedValueOnce({ ...room, initialized: true });
  journal.roomState.mockReturnValue(false);
  (assertInitializedRoomSource as jest.Mock).mockRejectedValueOnce(
    Error("deleted room"),
  );
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow("deleted");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(ensureUninitializedRoomParent).not.toHaveBeenCalled();
  await service.close();
});

test("thread creation waits for durable owner initialization acknowledgment", async () => {
  const { handlers, markInitialized, service } = await setup();
  markInitialized.mockRejectedValueOnce(Error("owner acknowledgment lost"));
  await expect(
    handlers.createThread.call(
      { subject },
      { expected_room_id: room.room_id, request_id, title: "Discussion" },
    ),
  ).rejects.toThrow("acknowledgment lost");
  expect(createHumanThread).not.toHaveBeenCalled();
  expect(releaseChatSyncDB).toHaveBeenCalled();
  await service.close();
});
test("only a newly created empty room arms first-message notifications", async () => {
  const { handlers, service } = await setup();
  (humanRoomMarker as jest.Mock).mockReturnValueOnce(false);
  await handlers.createThread.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  expect(journal.armNotifications).toHaveBeenCalledWith(
    { project_id: room.project_id, chat_path: room.chat_path },
    room.room_id,
    0,
  );
  journal.armNotifications.mockClear();
  await handlers.createThread.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  expect(journal.armNotifications).not.toHaveBeenCalled();
  await service.close();
});

test("parent directory is prepared before the first SyncDB acquisition", async () => {
  const { handlers, service } = await setup();
  await handlers.initialize.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  expect(ensureUninitializedRoomParent).toHaveBeenCalledWith({
    ...room,
    initialized: false,
  });
  expect(
    (ensureUninitializedRoomParent as jest.Mock).mock.invocationCallOrder[0],
  ).toBeLessThan((acquireChatSyncDB as jest.Mock).mock.invocationCallOrder[0]);
  await service.close();
});

test("parent creation failure does not open or initialize a chat", async () => {
  const { handlers, service } = await setup();
  (ensureUninitializedRoomParent as jest.Mock).mockRejectedValueOnce(
    Error("mkdir unavailable"),
  );
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow("mkdir unavailable");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(initializeHumanRoom).not.toHaveBeenCalled();
  await service.close();
});

test("lost source-save ACK retries a persisted marker and arms before the first message", async () => {
  const { handlers, service } = await setup();
  (humanRoomMarker as jest.Mock).mockReturnValueOnce(false);
  (initializeHumanRoom as jest.Mock).mockRejectedValueOnce(
    Error("source save ACK lost"),
  );
  await expect(
    handlers.createThread.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow("source save ACK lost");
  expect(journal.beginRoomInitialization).toHaveBeenCalledTimes(1);
  expect(journal.armNotifications).not.toHaveBeenCalled();
  expect(createHumanThread).not.toHaveBeenCalled();

  await handlers.createThread.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  await handlers.send.call(
    { subject },
    {
      expected_room_id: room.room_id,
      request_id,
      thread_id: request_id,
      text: "First message",
    },
  );
  expect(journal.armNotifications).toHaveBeenCalledTimes(1);
  expect(journal.beginRoomInitialization).toHaveBeenCalledTimes(1);
  expect(journal.armNotifications.mock.invocationCallOrder[0]).toBeLessThan(
    (createHumanThread as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(journal.armNotifications.mock.invocationCallOrder[0]).toBeLessThan(
    (sendHumanMessage as jest.Mock).mock.invocationCallOrder[0],
  );
  await service.close();
});

test("lost owner ACK does not rearm an already initialized room on retry", async () => {
  const { handlers, markInitialized, service } = await setup();
  (humanRoomMarker as jest.Mock).mockReturnValueOnce(false);
  markInitialized.mockRejectedValueOnce(Error("owner ACK lost"));
  await expect(
    handlers.createThread.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow("owner ACK lost");
  await handlers.createThread.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  expect(journal.armNotifications).toHaveBeenCalledTimes(1);
  expect(createHumanThread).toHaveBeenCalledTimes(1);
  await service.close();
});

test.each([false, true])(
  "restored existing marker without fresh journal intent never rearms (owner initialized=%s)",
  async (initialized) => {
    const { handlers, resolveRoom, service } = await setup();
    resolveRoom.mockResolvedValueOnce({ ...room, initialized });
    await handlers.createThread.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    );
    expect(journal.beginRoomInitialization).not.toHaveBeenCalled();
    expect(journal.armNotifications).not.toHaveBeenCalled();
    await service.close();
  },
);

test("owner-confirmed same-project room moves use the current locator", async () => {
  const { handlers, resolveRoom, service } = await setup();
  resolveRoom.mockResolvedValueOnce({
    ...room,
    initialized: true,
    chat_path: "/home/user/discussions/seminar.chat",
  });
  await handlers.initialize.call(
    { subject },
    { expected_room_id: room.room_id, request_id },
  );
  expect(acquireChatSyncDB).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/home/user/discussions/seminar.chat" }),
  );
  await service.close();
});

test("normal service use reconciles owner-confirmed retirement before local initialization", async () => {
  const { handlers, resolveRoom, service } = await setup();
  const resolved = {
    ...replacement,
    retired_rooms: [{ room_id: room.room_id, chat_path: room.chat_path }],
  };
  resolveRoom.mockResolvedValue(resolved);
  await handlers.initialize.call(
    { subject },
    { request_id, expected_room_id: replacement.room_id },
  );
  expect(journal.reconcileRoom).toHaveBeenCalledWith(resolved);
  expect(journal.reconcileRoom.mock.invocationCallOrder[0]).toBeLessThan(
    (acquireChatSyncDB as jest.Mock).mock.invocationCallOrder[0],
  );
  await service.close();
});
test("revocation during owner lookup is rechecked before opening the source", async () => {
  const { handlers, resolveRoom, service } = await setup();
  resolveRoom.mockImplementationOnce(async () => {
    (getRow as jest.Mock).mockReturnValue({ users: {} });
    return room;
  });
  await expect(
    handlers.initialize.call(
      { subject },
      { expected_room_id: room.room_id, request_id },
    ),
  ).rejects.toThrow(/collaborator/);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  await service.close();
});
