import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { extractCollaborationMetadata } from "@cocalc/chat";
import { CollaboratorsService } from "./service";
import { readCollaborationSource } from "./filesystem";
import type { CollaborationRead } from "./journal";
import { flushExistingCanonicalRoom } from "./flush";
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/.cocalc/collaborators.chat",
};
const room_id = "22222222-2222-4222-8222-222222222222";
let directory: string, service: CollaboratorsService;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-pipeline-"));
});
afterEach(async () => {
  await service?.close();
  rmSync(directory, { force: true, recursive: true });
});
function setup() {
  const opts = {
    filename: join(directory, "journal.sqlite"),
    enabled: jest.fn(async () => true),
    beforeRead: jest.fn(async () => {}),
    read: jest.fn(
      async (): Promise<CollaborationRead> => ({
        resources: [
          {
            ...source,
            kind: "conversation",
            resource_id: "thread",
            thread_id: "thread",
            title: "Chat",
            participant_ids: [],
            activity: 0,
            created_at: 0,
            updated_at: 0,
          },
        ],
        activity_ids: { thread: ["message"] },
        notification_room_id: room_id,
        notification_messages: [
          {
            version: 1,
            project_id: source.project_id,
            room_id,
            thread_id: "thread",
            message_id: "message",
            actor_account_id: source.project_id,
            mentioned_account_ids: [],
            mention_all: false,
          },
        ],
      }),
    ),
    writerState: jest.fn(async () => null),
    register: jest.fn(async () => ({ epoch: "epoch" })),
    send: jest.fn(async () => ({ revision: 1, replayed: false })),
    discover: jest.fn(async () => []),
    onError: jest.fn(),
    initializeCopy: jest.fn(async () => {}),
    now: jest.fn(() => 0),
  };
  service = new CollaboratorsService(opts);
  return opts;
}
test("disabled or failed enable lookup makes no catalog, data-plane or recovery calls", async () => {
  const opts = setup();
  service.journal.touch(source);
  opts.enabled
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(Error("unavailable"));
  await service.runOnce();
  await service.runOnce();
  for (const fn of [
    opts.read,
    opts.writerState,
    opts.register,
    opts.send,
    opts.discover,
    opts.initializeCopy,
  ])
    expect(fn).not.toHaveBeenCalled();
  await service.runOnce();
  expect(opts.send).toHaveBeenCalledTimes(1);
});
test("live event producer actually retries through ingest after process restart", async () => {
  const opts = setup();
  service.journal.armNotifications(source, room_id);
  opts.send.mockRejectedValueOnce(Error("owner ack lost"));
  await service.runOnce();
  const first = (opts.send.mock.calls as any)[0][0];
  expect(first.notification_events).toEqual([
    expect.objectContaining({
      message_id: "message",
      mode: "live",
      activity: 1,
    }),
  ]);
  await service.close();
  service = new CollaboratorsService(opts);
  opts.now.mockReturnValue(2000);
  await service.runOnce();
  expect(opts.send.mock.calls[1]).toEqual(opts.send.mock.calls[0]);
  expect(service.journal.deliveries()).toEqual([]);
  expect(opts.read).toHaveBeenCalledTimes(1);
});
test("browser-shaped human messages enter participation and live activity only after the disk snapshot is flushed", async () => {
  const opts = setup();
  const account_id = "00000000-1000-4000-8000-000000000001";
  const rows: Record<string, unknown>[] = [
    {
      event: "collaborators-room",
      project_id: source.project_id,
      room_id,
      mode: "human",
      schema_version: 1,
    },
    { event: "chat-thread", thread_id: "thread", created_by: account_id },
    { event: "chat-thread-config", thread_id: "thread", agent_kind: "none" },
  ];
  const serialize = () => rows.map((row) => JSON.stringify(row)).join("\n");
  let disk = serialize();
  const fs = {
    createReadStream: async () => Readable.from([Buffer.from(disk)]),
  };
  opts.read.mockImplementation(async () =>
    extractCollaborationMetadata(
      await readCollaborationSource(fs as any, source.chat_path),
      source,
    ),
  );
  service.journal.armNotifications(source, room_id);
  await service.runOnce();
  expect((opts.send.mock.calls as any)[0][0].resources[0]).toMatchObject({
    participant_ids: [],
    participant_count: 0,
    activity: 0,
  });
  for (let i = 0; i < 2; i++)
    rows.push({
      event: "chat",
      schema_version: 2,
      sender_id: account_id,
      thread_id: "thread",
      message_id: `browser-message-${i}`,
      date: new Date(1000 + i).toISOString(),
      history: [{ author_id: account_id, content: "Human discussion" }],
      editing: {},
    });
  // Patchflow durability alone does not update the source reader's disk view.
  service.journal.touch(source);
  await service.runOnce();
  expect((opts.send.mock.calls as any)[1][0].resources[0].activity).toBe(0);

  let lostAck = true;
  const saveDisk = jest.fn(async () => {
    const token = service.journal.beginWrite(source);
    try {
      disk = serialize();
      if (lostAck) {
        lostAck = false;
        throw Error("disk ACK lost");
      }
    } finally {
      service.journal.finishWrite(token);
    }
  });
  opts.beforeRead.mockImplementation(async () => {
    await flushExistingCanonicalRoom({
      room: { ...source, room_id, initialized: true },
      assertCurrent: async () => {},
      read: () => readCollaborationSource(fs as any, source.chat_path),
      acquire: async () => ({
        get: () => rows,
        save: async () => {},
        save_to_disk: saveDisk,
      }),
      release: async () => {},
    });
  });
  service.journal.touch(source);
  await service.runOnce();
  expect(opts.send).toHaveBeenCalledTimes(2);
  expect(opts.onError).toHaveBeenCalledWith(
    expect.objectContaining(source),
    expect.objectContaining({ message: "disk ACK lost" }),
  );
  opts.onError.mockClear();
  // No browser, manual disk write or new source touch after worker restart.
  await service.close();
  service = new CollaboratorsService(opts);
  opts.now.mockReturnValue(2000);
  await service.runOnce();
  expect(saveDisk).toHaveBeenCalledTimes(1);
  const delivery = (opts.send.mock.calls as any)[2][0];
  expect(delivery.resources[0]).toMatchObject({
    kind: "conversation",
    participant_ids: [account_id],
    participant_count: 1,
    activity: 2,
  });
  expect(delivery.notification_events).toEqual([
    expect.objectContaining({
      message_id: "browser-message-0",
      activity: 1,
      mode: "live",
    }),
    expect.objectContaining({
      message_id: "browser-message-1",
      activity: 2,
      mode: "live",
    }),
  ]);
  expect(opts.onError).not.toHaveBeenCalled();
});
test("reenable reconciles disabled-period history without emitting it as live notifications", async () => {
  const opts = setup();
  const history = await opts.read();
  opts.read.mockResolvedValue(history);
  service.journal.armNotifications(source, room_id);
  await service.runOnce();
  opts.enabled.mockResolvedValue(false);
  await service.runOnce();
  const append = (message_id: string) => {
    history.activity_ids.thread.push(message_id);
    history.notification_messages!.push({
      ...history.notification_messages![0],
      message_id,
    });
  };
  append("while-disabled");
  opts.enabled.mockResolvedValue(true);
  await service.runOnce();
  const baseline = (opts.send.mock.calls as any)[1][0];
  expect(baseline.resources[0].activity).toBe(2);
  expect(baseline.notification_events).toBeUndefined();
  append("after-reenable");
  service.journal.touch(source);
  await service.runOnce();
  expect((opts.send.mock.calls as any)[2][0].notification_events).toEqual([
    expect.objectContaining({ message_id: "after-reenable", activity: 3 }),
  ]);
});
test("ready copies save through the injected live service before quarantine release, retrying the same intent", async () => {
  const opts = setup();
  const operation = service.journal.beginCopy(
    source,
    "/home/user/original.chat",
    true,
  );
  service.journal.finishCopy(operation, "source-fingerprint");
  opts.initializeCopy.mockRejectedValueOnce(Error("save ack lost"));
  await service.runOnce();
  expect(opts.send).not.toHaveBeenCalled();
  expect(service.journal.copies()).toHaveLength(1);
  opts.now.mockReturnValue(2000);
  await service.runOnce();
  expect(opts.initializeCopy.mock.calls[1][0]).toMatchObject({
    operation_id: operation,
    state: "ready",
    fingerprint: "source-fingerprint",
  });
  expect(service.journal.copies()).toEqual([]);
  expect(opts.send).toHaveBeenCalledTimes(1);
});
