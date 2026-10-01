import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaboratorsService } from "./service";
import type { CollaborationRead } from "./journal";
const project_id = "11111111-1111-4111-8111-111111111111";
const source = { project_id, chat_path: "/home/user/original.chat" };
const destination = { project_id, chat_path: "/home/user/moved.chat" };
const room_id = "22222222-2222-4222-8222-222222222222";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-relocation-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function read(at = source, ids = ["message"]): CollaborationRead {
  return {
    resources: [
      {
        ...at,
        kind: "conversation",
        resource_id: "thread",
        thread_id: "thread",
        title: "Chat",
        participant_ids: [],
        created_at: 0,
        updated_at: 0,
        activity: 0,
      },
    ],
    activity_ids: { thread: ids },
    notification_room_id: room_id,
    notification_messages: ids.map((message_id) => ({
      version: 1,
      project_id,
      room_id,
      thread_id: "thread",
      message_id,
      actor_account_id: project_id,
      mentioned_account_ids: [],
      mention_all: true,
    })),
  };
}
function setup() {
  const states = new Map<
    string,
    { epoch: string; registration_id: string | null }
  >();
  const opts = {
    filename: join(directory, "journal.sqlite"),
    writerState: jest.fn(
      async (source) => states.get(source.chat_path) ?? null,
    ),
    register: jest.fn(async (source) => {
      const state = {
        epoch: "source-epoch",
        registration_id: source.registration_id,
      };
      states.set(source.chat_path, state);
      return state;
    }),
    relocate: jest.fn(async (request) => {
      states.set(request.from_chat_path, {
        epoch: "retired-epoch",
        registration_id: null,
      });
      states.set(request.to_chat_path, {
        epoch: "destination-epoch",
        registration_id: request.operation_id,
      });
      return { epoch: "destination-epoch", revision: 2 };
    }),
    read: jest.fn(async (source) => read(source)),
    send: jest.fn(async () => ({ revision: 3, replayed: false })),
    discover: jest.fn(async () => []),
    onError: jest.fn(),
    now: jest.fn(() => 0),
  };
  return { opts, states };
}
test("runtime relocation freezes CAS inputs, survives lost ACK/restart, adopts destination epoch and retires old scans", async () => {
  const { opts } = setup();
  let service = new CollaboratorsService(opts);
  try {
    service.journal.touch(source);
    await service.runOnce();
    const operation = service.journal.beginRelocation(
      source,
      destination.chat_path,
    );
    service.journal.finishRelocation(operation, true);
    const apply = opts.relocate.getMockImplementation()!;
    opts.relocate.mockImplementationOnce(async (request) => {
      await apply(request);
      throw Error("owner ACK lost");
    });
    await service.runOnce();
    const frozen = opts.relocate.mock.calls[0][0];
    expect(frozen).toMatchObject({
      operation_id: operation,
      expected_epoch: "source-epoch",
      expected_destination_epoch: null,
    });
    expect(
      opts.register.mock.calls.every(
        ([source]) => source.chat_path !== destination.chat_path,
      ),
    ).toBe(true);
    const lookups = opts.writerState.mock.calls.length;
    await service.close();
    service = new CollaboratorsService(opts);
    opts.now.mockReturnValue(2000);
    await service.runOnce();
    expect(opts.relocate.mock.calls[1][0]).toEqual(frozen);
    expect(opts.writerState.mock.calls).toHaveLength(lookups);
    expect(service.journal.relocations()).toEqual([]);
    expect(service.journal.sources()).toEqual([destination]);
    expect((opts.send.mock.calls as any).at(-1)[0]).toMatchObject({
      ...destination,
      epoch: "destination-epoch",
      resources: [expect.objectContaining({ activity: 1 })],
    });
    service.journal.touch(source);
    expect(service.journal.scans()).toEqual([]);
    expect(service.journal.registrations()).toEqual([]);
  } finally {
    await service.close();
  }
});
test("pending notification facts and metadata survive relocation with only transport locator/epoch changed", async () => {
  const { opts } = setup();
  const service = new CollaboratorsService(opts);
  try {
    service.journal.armNotifications(source, room_id);
    opts.send.mockRejectedValueOnce(Error("ingest ACK lost"));
    await service.runOnce();
    const before = (opts.send.mock.calls as any)[0][0];
    const operation = service.journal.beginRelocation(
      source,
      destination.chat_path,
    );
    service.journal.finishRelocation(operation, true);
    opts.now.mockReturnValue(2000);
    await service.runOnce();
    const after = (opts.send.mock.calls as any)[1][0];
    expect(after).toMatchObject({ ...destination, epoch: "destination-epoch" });
    expect(after.notification_events).toEqual(before.notification_events);
    service.journal.acknowledge(before);
    opts.read.mockImplementation(async (source) =>
      read(source, ["message", "new"]),
    );
    await service.runOnce();
    expect((opts.send.mock.calls as any)[2][0].notification_events).toEqual([
      expect.objectContaining({ message_id: "new", activity: 2 }),
    ]);
  } finally {
    await service.close();
  }
});
test("copy-before-namespace followed immediately by rename retains copy quarantine at its new path", async () => {
  const { opts } = setup();
  const service = new CollaboratorsService(opts);
  try {
    const copy = service.journal.beginCopy(
      source,
      "/home/user/other.chat",
      true,
    );
    service.journal.finishCopy(copy, "fingerprint");
    const operation = service.journal.beginRelocation(
      source,
      destination.chat_path,
    );
    service.journal.finishRelocation(operation, true);
    await service.runOnce();
    expect(service.journal.copies()).toEqual([
      expect.objectContaining({
        ...destination,
        operation_id: copy,
        state: "ready",
      }),
    ]);
    expect(opts.send).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});
