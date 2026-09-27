import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationJournal, type CollaborationRead } from "./journal";
import { CollaboratorsService } from "./service";
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/.cocalc/collaborators.chat",
};
const room_id = "22222222-2222-4222-8222-222222222222";
const resource = {
  ...source,
  kind: "conversation" as const,
  resource_id: "thread",
  thread_id: "thread",
  participant_ids: [],
  created_at: 0,
  updated_at: 0,
  title: "Chat",
  activity: 0,
};
function read(ids: string[]): CollaborationRead {
  return {
    resources: [resource],
    activity_ids: { thread: ids },
    notification_room_id: room_id,
    notification_messages: ids.map((message_id) => ({
      version: 1,
      project_id: source.project_id,
      room_id,
      thread_id: "thread",
      message_id,
      actor_account_id: source.project_id,
      mentioned_account_ids: [],
      mention_all: true,
    })),
  };
}
let directory: string, journal: CollaborationJournal;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-recovery-"));
  journal = new CollaborationJournal(
    join(directory, "journal.sqlite"),
    undefined,
    true,
  );
  journal.touch(source);
  journal.registered(journal.registrations()[0], "epoch");
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function page(activity = 100, next?: string) {
  return {
    epoch: "epoch",
    resources: [
      { kind: "conversation" as const, resource_id: "thread", activity },
    ],
    ...(next ? { next } : {}),
  };
}
function prepare(ids: string[]) {
  journal.touch(source);
  journal.prepare(journal.scans()[0], read(ids));
  return journal.deliveries()[0];
}
test("lost host journal baselines visible IDs at owner floor, then next message advances immediately", () => {
  expect(journal.scans()).toEqual([]);
  journal.importActivityPage({ ...source, epoch: "epoch" }, page());
  const first = prepare(Array.from({ length: 20 }, (_, i) => `old-${i}`));
  expect(first.resources[0].activity).toBe(100);
  expect(first.notification_events).toBeUndefined();
  journal.acknowledge(first);
  const next = prepare([
    ...Array.from({ length: 20 }, (_, i) => `old-${i}`),
    "new",
  ]);
  expect(next.resources[0].activity).toBe(101);
  expect(next.notification_events).toEqual([
    expect.objectContaining({ message_id: "new", activity: 101 }),
  ]);
  journal.acknowledge(next);
  expect(prepare(["new"]).resources[0].activity).toBe(101);
});
test("checkpoint cursor survives crash; partial and stale checkpoints never permit publication", () => {
  const writer = { ...source, epoch: "epoch" };
  expect(journal.importActivityPage(writer, page(100, "next"))).toBe(false);
  journal.close();
  journal = new CollaborationJournal(
    join(directory, "journal.sqlite"),
    undefined,
    true,
  );
  expect(journal.activityRecovery(writer)).toEqual({
    complete: false,
    after: "next",
  });
  expect(journal.scans()).toEqual([]);
  expect(() =>
    journal.importActivityPage(writer, { ...page(), epoch: "wrong" }),
  ).toThrow(/epoch/);
  journal.importActivityPage(writer, {
    epoch: "epoch",
    resources: [
      { kind: "conversation", resource_id: "deleted-thread", activity: 500 },
    ],
  });
  expect(prepare(["history"]).resources[0].activity).toBe(100);
  journal.reassign(source, "next-epoch");
  expect(journal.importActivityPage(writer, page())).toBe(false);
});
test("fresh empty room retains first live message even with an empty owner checkpoint", () => {
  journal.armNotifications(source, room_id);
  journal.importActivityPage(
    { ...source, epoch: "epoch" },
    { epoch: "epoch", resources: [] },
  );
  expect(prepare(["first"]).notification_events?.[0].activity).toBe(1);
});
test("recovered pending event facts remain immutable while their metadata honors newer owner floors", () => {
  journal.armNotifications(source, room_id);
  journal.importActivityPage(
    { ...source, epoch: "epoch" },
    { epoch: "epoch", resources: [] },
  );
  const first = prepare(["message"]);
  journal.reassign(source, "other-epoch");
  journal.registered(journal.registrations()[0], "new-epoch");
  expect(journal.deliveries()).toEqual([]);
  journal.importActivityPage(
    { ...source, epoch: "new-epoch" },
    { ...page(), epoch: "new-epoch" },
  );
  const replay = journal.deliveries()[0];
  expect(replay.resources[0].activity).toBe(100);
  expect(replay.notification_events).toEqual(first.notification_events);
});
test("checkpoint shape and capacity fail atomically", () => {
  const writer = { ...source, epoch: "epoch" };
  expect(() =>
    journal.importActivityPage(writer, {
      epoch: "epoch",
      resources: Array.from({ length: 101 }, () => page().resources[0]),
    }),
  ).toThrow(/page/);
  expect(() => journal.importActivityPage(writer, page(-1))).toThrow(/floor/);
  expect(journal.activityRecovery(writer).complete).toBe(false);
});
test("actual worker imports bounded pages before reading/sending and resumes after restart", async () => {
  const options = {
    filename: join(directory, "worker.sqlite"),
    sourceActivity: jest.fn(async (source) =>
      source.after ? { epoch: "epoch", resources: [] } : page(100, "page-2"),
    ),
    writerState: jest.fn(async () => null),
    register: jest.fn(async () => ({ epoch: "epoch" })),
    read: jest.fn(async () => read(["history"])),
    send: jest.fn(async () => ({ revision: 1, replayed: false })),
    discover: jest.fn(async () => []),
    onError: jest.fn(),
    now: () => 0,
  };
  let service = new CollaboratorsService(options);
  try {
    service.journal.touch(source);
    await service.runOnce();
    expect(options.read).not.toHaveBeenCalled();
    expect(options.send).not.toHaveBeenCalled();
    await service.close();
    service = new CollaboratorsService(options);
    await service.runOnce();
    expect(options.sourceActivity.mock.calls[1][0]).toMatchObject({
      after: "page-2",
    });
    expect((options.send.mock.calls as any)[0][0].resources[0].activity).toBe(
      100,
    );
    options.read.mockResolvedValue(read(["history", "new"]));
    service.journal.touch(source);
    await service.runOnce();
    expect((options.send.mock.calls as any)[1][0].resources[0].activity).toBe(
      101,
    );
    expect(options.onError).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});
test("expired checkpoint cursors restart paging without losing floors or publishing an incomplete import", async () => {
  let now = 0;
  const sourceActivity = jest
    .fn()
    .mockResolvedValueOnce(page(100, "expired-page"))
    .mockRejectedValueOnce(
      Error("collaboration checkpoint changed; restart paging"),
    )
    .mockResolvedValueOnce({ epoch: "epoch", resources: [] });
  const options = {
    filename: join(directory, "cursor.sqlite"),
    sourceActivity,
    writerState: async () => null,
    register: async () => ({ epoch: "epoch" }),
    read: jest.fn(async () => read(["old"])),
    send: jest.fn(async () => ({ revision: 1, replayed: false })),
    discover: async () => [],
    onError: jest.fn(),
    now: () => now,
  };
  const service = new CollaboratorsService(options);
  try {
    service.journal.touch(source);
    await service.runOnce();
    await service.runOnce();
    expect(options.send).not.toHaveBeenCalled();
    expect(
      service.journal.activityRecovery({ ...source, epoch: "epoch" }),
    ).toEqual({ complete: false });
    now = 2000;
    await service.runOnce();
    expect(sourceActivity.mock.calls[2][0]).not.toHaveProperty("after");
    expect((options.send.mock.calls as any)[0][0].resources[0].activity).toBe(
      100,
    );
  } finally {
    await service.close();
  }
});
