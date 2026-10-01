import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import { createLiteCollaborators } from "./service";
import { initLiteCollaboratorsRoomService } from "./room-service";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));
const identity = {
  project_id: "11111111-1111-4111-8111-111111111111",
  account_id: "22222222-2222-4222-8222-222222222222",
};
const subject = `services.account-${identity.account_id}._.${identity.project_id}._.collaborators`;
let directory: string;
let runtime: ReturnType<typeof createLiteCollaborators>;
let roomService: Awaited<ReturnType<typeof initLiteCollaboratorsRoomService>>;
let handlers: any;
const rows = new Map<string, any[]>();
let loseDiskAck = false;
function start() {
  runtime = createLiteCollaborators({
    ...identity,
    directory: join(directory, "private"),
    path: directory,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  });
}
async function bind() {
  roomService = await initLiteCollaboratorsRoomService(
    {
      service: async (_subject: string, methods: any) => {
        handlers = methods;
        return { close: () => {} };
      },
    } as any,
    runtime,
  );
}
beforeEach(async () => {
  jest.clearAllMocks();
  rows.clear();
  loseDiskAck = false;
  directory = mkdtempSync(join(tmpdir(), "lite-room-replacement-service-"));
  jest.mocked(acquireChatSyncDB).mockImplementation(async ({ path }) => {
    const values = rows.get(path) ?? [];
    rows.set(path, values);
    return {
      get: () => values,
      set: (row) => values.push(row),
      commit: () => {},
      save: async () => {},
      save_to_disk: async () => {
        writeFileSync(
          path,
          values.map((row) => JSON.stringify(row)).join("\n"),
        );
        if (loseDiskAck) {
          loseDiskAck = false;
          throw Error("lost disk acknowledgement");
        }
      },
    } as any;
  });
  jest.mocked(releaseChatSyncDB).mockResolvedValue(undefined);
  start();
  await bind();
});
afterEach(async () => {
  await roomService.close();
  await runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

async function deletedRoom() {
  const room = await runtime.api.ensureRoom({
    ...identity,
    request_id: randomUUID(),
  });
  await handlers.initialize.call(
    { subject },
    { request_id: randomUUID(), expected_room_id: room.room_id },
  );
  expect(existsSync(room.chat_path)).toBe(true);
  rmSync(room.chat_path);
  return {
    room,
    request: {
      version: 1 as const,
      project_id: room.project_id,
      request_id: randomUUID(),
      expected_room_id: room.room_id,
      expected_chat_path: room.chat_path,
    },
  };
}

test("actual Lite filesystem and owner/journal transition create only a new marker through the chat service", async () => {
  const { room, request } = await deletedRoom();
  const result = await handlers.replaceRoom.call({ subject }, request);
  expect(result.outcome).toBe("ready");
  expect(result.room.room_id).not.toBe(room.room_id);
  expect(existsSync(room.chat_path)).toBe(false);
  const stored = readFileSync(result.room.chat_path, "utf8")
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    event: "collaborators-room",
    room_id: result.room.room_id,
  });
  expect(() => runtime.service.journal.beginWrite(room)).toThrow("retired");
  jest.mocked(acquireChatSyncDB).mockClear();
  for (const method of ["initialize", "createThread", "send"])
    await expect(
      handlers[method].call(
        { subject },
        {
          request_id: randomUUID(),
          expected_room_id: room.room_id,
          thread_id: randomUUID(),
          text: "stale",
        },
      ),
    ).rejects.toThrow("stale");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});

test("owner commit followed by process loss replays the same receipt and initializes exactly one replacement", async () => {
  const { request } = await deletedRoom();
  const pending = await runtime.replaceRoom(request, identity);
  if (pending.outcome === "superseded") throw Error("unexpected supersession");
  expect(pending.outcome).toBe("pending");
  expect(existsSync(pending.room.chat_path)).toBe(false);
  await roomService.close();
  await runtime.close();
  start();
  await bind();
  const first = await handlers.replaceRoom.call({ subject }, request);
  expect(first).toMatchObject({
    outcome: "ready",
    operation_id: pending.operation_id,
    room: { room_id: pending.room.room_id },
  });
  const content = readFileSync(first.room.chat_path, "utf8");
  expect(await handlers.replaceRoom.call({ subject }, request)).toEqual(first);
  expect(readFileSync(first.room.chat_path, "utf8")).toBe(content);
});

test("ordinary creation reconciles a lost replacement ACK without replaying the original owner's request", async () => {
  const { room, request } = await deletedRoom();
  const transition = jest
    .spyOn(runtime.service.journal, "replaceRoom")
    .mockImplementationOnce(() => {
      throw Error("crash after owner commit");
    });
  await expect(runtime.replaceRoom(request, identity)).rejects.toThrow(
    "crash after owner commit",
  );
  transition.mockRestore();
  const current = (await runtime.store.registeredRoom(identity))!;
  expect(current.room_id).not.toBe(room.room_id);
  expect(runtime.service.journal.roomState(room.project_id, room.room_id)).toBe(
    true,
  );
  await handlers.createThread.call(
    { subject },
    {
      request_id: randomUUID(),
      expected_room_id: current.room_id,
      title: "Recovered discussion",
    },
  );
  expect(existsSync(current.chat_path)).toBe(true);
  expect(
    rows.get(current.chat_path)!.filter((row) => row.event === "chat-thread"),
  ).toHaveLength(1);
  expect(() =>
    runtime.service.journal.roomState(room.project_id, room.room_id),
  ).toThrow("retired");
  expect((await runtime.store.registeredRoom(identity))?.initialized).toBe(
    true,
  );
});

test("a corrupt but present original is not evidence of deletion", async () => {
  const { room, request } = await deletedRoom();
  writeFileSync(room.chat_path, "{not a chat");
  jest.mocked(acquireChatSyncDB).mockClear();
  await expect(handlers.replaceRoom.call({ subject }, request)).rejects.toThrow(
    "still exists",
  );
  expect(await runtime.store.registeredRoom(identity)).toMatchObject({
    room_id: room.room_id,
  });
  expect(readFileSync(room.chat_path, "utf8")).toBe("{not a chat");
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
});

test("a restored corrupt pending destination remains untouched through replacement and ordinary retries", async () => {
  const { request } = await deletedRoom();
  const pending = await runtime.replaceRoom(request, identity);
  if (pending.outcome === "superseded") throw Error("unexpected supersession");
  await runtime.ensureRoomDirectory(pending.room);
  const bytes = "{corrupt restored destination\n";
  writeFileSync(pending.room.chat_path, bytes);
  jest.mocked(acquireChatSyncDB).mockClear();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      handlers.replaceRoom.call({ subject }, request),
    ).rejects.toThrow();
    expect(readFileSync(pending.room.chat_path, "utf8")).toBe(bytes);
  }
  await expect(
    handlers.initialize.call(
      { subject },
      {
        request_id: randomUUID(),
        expected_room_id: pending.room.room_id,
      },
    ),
  ).rejects.toThrow();
  expect(readFileSync(pending.room.chat_path, "utf8")).toBe(bytes);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect((await runtime.store.registeredRoom(identity))?.initialized).toBe(
    false,
  );
});

test.each([false, true])(
  "lost disk ACK retry validates persisted destination before opening cached SyncDB (corrupt=%s)",
  async (corrupt) => {
    const { request } = await deletedRoom();
    loseDiskAck = true;
    await expect(
      handlers.replaceRoom.call({ subject }, request),
    ).rejects.toThrow("lost disk acknowledgement");
    const current = (await runtime.store.registeredRoom(identity))!;
    expect(current.initialized).toBe(false);
    expect(
      runtime.service.journal.roomState(current.project_id, current.room_id),
    ).toBe(false);
    const saved = readFileSync(current.chat_path, "utf8");
    expect(JSON.parse(saved).room_id).toBe(current.room_id);
    const bytes = corrupt ? `${saved}\n{corrupt restored row\n` : saved;
    writeFileSync(current.chat_path, bytes);
    jest.mocked(acquireChatSyncDB).mockClear();
    if (corrupt) {
      await expect(
        handlers.replaceRoom.call({ subject }, request),
      ).rejects.toThrow();
      expect(acquireChatSyncDB).not.toHaveBeenCalled();
      await roomService.close();
      await runtime.close();
      start();
      await bind();
      await expect(
        handlers.replaceRoom.call({ subject }, request),
      ).rejects.toThrow();
      expect(acquireChatSyncDB).not.toHaveBeenCalled();
    } else {
      expect(
        await handlers.replaceRoom.call({ subject }, request),
      ).toMatchObject({
        outcome: "ready",
        room: { room_id: current.room_id },
      });
      expect(acquireChatSyncDB).toHaveBeenCalledTimes(1);
    }
    expect(readFileSync(current.chat_path, "utf8")).toBe(bytes);
  },
);

test("replaying a ready receipt never recreates a subsequently deleted replacement", async () => {
  const { request } = await deletedRoom();
  const first = await handlers.replaceRoom.call({ subject }, request);
  rmSync(first.room.chat_path);
  jest.mocked(acquireChatSyncDB).mockClear();
  await expect(handlers.replaceRoom.call({ subject }, request)).rejects.toThrow(
    /deleted|missing/,
  );
  expect(existsSync(first.room.chat_path)).toBe(false);
  expect(acquireChatSyncDB).not.toHaveBeenCalled();
  expect(await runtime.store.registeredRoom(identity)).toMatchObject({
    room_id: first.room.room_id,
    initialized: true,
  });
});
