import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationJournal, type CollaborationRead } from "./journal";
import { SOURCE_EVENT_BATCH_LIMIT } from "./notifications";
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/.cocalc/collaborators.chat",
};
const room = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
let journal: CollaborationJournal, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-notifications-"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  journal.touch(source);
  journal.registered(journal.registrations()[0], "epoch");
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function read(ids: string[], lifecycle_generation = 0): CollaborationRead {
  return {
    resources: [
      {
        ...source,
        resource_id: "thread",
        thread_id: "thread",
        kind: "conversation",
        title: "Chat",
        participant_ids: [],
        created_at: 0,
        updated_at: 0,
        activity: 0,
      },
    ],
    activity_ids: { thread: ids },
    notification_room_id: room,
    lifecycle_generation,
    notification_messages: ids.map((message_id) => ({
      version: 1,
      project_id: source.project_id,
      room_id: room,
      thread_id: "thread",
      message_id,
      actor_account_id: actor,
      mentioned_account_ids: [],
      mention_all: true,
    })),
  };
}
function prepare(value: CollaborationRead) {
  journal.touch(source);
  expect(journal.prepare(journal.scans()[0], value)).toBe(true);
  return journal.deliveries()[0];
}
test("first scan is backfill; live messages have journal positions, not clocks", () => {
  const initial = prepare(read(["history"]));
  expect(initial.notification_events).toBeUndefined();
  journal.acknowledge(initial);
  const live = prepare(read(["new", "history"]));
  expect(live.notification_events).toEqual([
    expect.objectContaining({ message_id: "new", activity: 2, mode: "live" }),
  ]);
  journal.acknowledge(live);
  expect(prepare(read(["history", "new"])).notification_events).toBeUndefined();
});
test("fresh empty-room creation arms first-message delivery; retry freezes targets across crashes and edits", () => {
  journal.armNotifications(source, room);
  const value = read(["message"]);
  const first = prepare(value);
  expect(first.notification_events?.[0].activity).toBe(1);
  journal.touch(source);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.deliveries()).toEqual([first]);
  journal.acknowledge(first);
  value.notification_messages![0].mention_all = false;
  expect(prepare(value).notification_events).toBeUndefined();
});
test("durable fresh-room retry arms a first message even before any background scan", () => {
  journal.beginRoomInitialization(source, room, 0);
  // The marker save reached disk, but its ACK did not. Retry after restart.
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.pendingRoomInitialization(source, room, 0)).toBe(true);
  journal.armNotifications(source, room, 0);
  journal.initializedRoom(source.project_id, room);
  expect(prepare(read(["first-message"])).notification_events).toEqual([
    expect.objectContaining({
      message_id: "first-message",
      activity: 1,
      mode: "live",
    }),
  ]);
});
test("restore generation and deleted-file reappearance establish backfill boundaries", () => {
  journal.armNotifications(source, room);
  let snapshot = prepare(read(["old"]));
  journal.acknowledge(snapshot);
  snapshot = prepare(read(["old", "restored"], 1));
  expect(snapshot.notification_events).toBeUndefined();
  journal.acknowledge(snapshot);
  snapshot = prepare(read(["old", "restored", "live"], 1));
  expect(snapshot.notification_events?.map((e) => e.message_id)).toEqual([
    "live",
  ]);
  journal.acknowledge(snapshot);
  journal.acknowledge(prepare({ resources: [], activity_ids: {} }));
  expect(
    prepare(read(["unexpected-history"], 1)).notification_events,
  ).toBeUndefined();
});
test("bursts drain complete bounded batches before a newer source can remove their resources", () => {
  journal.armNotifications(source, room);
  const ids = Array.from(
    { length: SOURCE_EVENT_BATCH_LIMIT * 2 + 3 },
    (_, i) => `message-${String(i).padStart(4, "0")}`,
  );
  const first = prepare(read(ids));
  journal.touch(source);
  const events: string[] = [];
  let snapshot = first;
  while (snapshot) {
    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.resources[0].activity).toBe(ids.length);
    expect(snapshot.notification_events!.length).toBeLessThanOrEqual(
      SOURCE_EVENT_BATCH_LIMIT,
    );
    events.push(...snapshot.notification_events!.map((e) => e.message_id));
    journal.acknowledge(snapshot);
    journal.acknowledge(first); // late ack cannot consume the next batch
    snapshot = journal.deliveries()[0];
  }
  expect(events).toEqual(ids);
  expect(journal.scans()).toHaveLength(1);
});
test("writer fencing preserves event intent and frozen resource state through a new epoch", () => {
  journal.armNotifications(source, room);
  const before = prepare(read(["message"]));
  journal.reassign(source, "other-epoch");
  expect(journal.deliveries()).toEqual([]);
  journal.registered(journal.registrations()[0], "new-epoch");
  const after = journal.deliveries()[0];
  expect(after.epoch).toBe("new-epoch");
  expect(after.notification_events).toEqual(before.notification_events);
  journal.acknowledge(before);
  expect(journal.deliveries()).toEqual([after]);
  journal.acknowledge(after);
});
test("failed capacity checks roll back activity and notification facts together", () => {
  journal.armNotifications(source, room);
  const oversized = read(["message"]);
  oversized.resources[0].title = "x".repeat(2 * 1024 * 1024);
  expect(() => prepare(oversized)).toThrow(/capacity/);
  expect(journal.deliveries()).toEqual([]);
  expect(prepare(read(["message"])).notification_events?.[0].activity).toBe(1);
});
