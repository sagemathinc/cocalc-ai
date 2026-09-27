import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationJournal } from "./journal";
import type { CollaborationRead } from "./journal";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/test.chat",
};
const read = (
  ids = ["message-1"],
  title = "Discussion",
): CollaborationRead => ({
  resources: [
    {
      ...source,
      kind: "conversation",
      resource_id: "thread",
      thread_id: "thread",
      title,
      participant_ids: [],
      created_at: 1,
      updated_at: 2,
      activity: 0,
    },
  ],
  activity_ids: { thread: ids },
});
let directory: string, journal: CollaborationJournal;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaborators-journal-"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function register() {
  journal.touch(source);
  const registration = journal.registrations()[0];
  journal.registered(registration, "epoch-1");
  return registration;
}
function prepare(value = read()) {
  const scan = journal.scans()[0];
  expect(scan).toBeDefined();
  expect(journal.prepare(scan, value)).toBe(true);
  return journal.deliveries()[0];
}

test("registration identity and CAS base survive restart and retries", () => {
  journal.touch(source);
  const before = journal.registrations()[0];
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.registrations()[0]).toEqual(before);
  journal.defer(before, 100);
  expect(journal.registrations(16, 100)).toEqual([]);
  expect(journal.registrations(16, 1100)[0]).toEqual(before);
  journal.registered(before, "epoch-1");
  journal.reassign(source, "epoch-2");
  const next = journal.registrations()[0];
  expect(next.registration_id).not.toBe(before.registration_id);
  expect(next.expected_epoch).toBe("epoch-2");
  journal.registered(before, "stale-epoch");
  expect(journal.scans()).toEqual([]);
});

test("write-ahead intent fences racing scans and survives interrupted writes", () => {
  register();
  const scan = journal.scans()[0];
  const token = journal.beginWrite(source);
  expect(journal.scans()).toEqual([]);
  expect(journal.prepare(scan, read())).toBe(false);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.scans()).toEqual([]);
  journal.recoverInterruptedWrites();
  expect(journal.prepare(scan, read())).toBe(false);
  journal.finishWrite(token);
  expect(prepare().sequence).toBe(1);
});

test("lost ack is replayed byte-for-byte despite newer writes and late ack leaves new work dirty", () => {
  register();
  const first = prepare();
  journal.touch(source);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.deliveries()).toEqual([first]);
  expect(journal.scans()).toEqual([]);
  journal.acknowledge(first);
  const second = prepare(read(["message-1", "message-2"]));
  expect(second.sequence).toBe(2);
  expect(second.resources[0].activity).toBe(2);
  journal.acknowledge(first);
  expect(journal.deliveries()).toEqual([second]);
});

test("rename, message edits, removals, rescan and replay do not advance unread activity", () => {
  register();
  let payload = prepare();
  expect(payload.resources[0].activity).toBe(1);
  for (const value of [
    read(["message-1"], "Renamed"),
    read([]),
    read(["message-1"]),
  ]) {
    journal.acknowledge(payload);
    journal.touch(source);
    payload = prepare(value);
    expect(payload.resources[0].activity).toBe(1);
  }
  journal.acknowledge(payload);
  journal.touch(source);
  payload = prepare({ resources: [], activity_ids: {} });
  journal.acknowledge(payload);
  journal.touch(source);
  expect(prepare(read(["message-1", "message-2"])).resources[0].activity).toBe(
    2,
  );
});

test("oversized snapshots fail atomically without preparing a partial deletion", () => {
  register();
  const tooLarge = read();
  tooLarge.resources[0].title = "x".repeat(2 * 1024 * 1024);
  expect(() => prepare(tooLarge)).toThrow(/capacity/);
  expect(journal.deliveries()).toEqual([]);
  expect(prepare().sequence).toBe(1);
});
test("declared partial participant coverage is durably delivered with the resource, never an omission", () => {
  register();
  const value = read();
  value.coverage = "partial";
  value.coverage_message =
    "Additional participants are not available to person filters.";
  const snapshot = prepare(value);
  expect(snapshot.resources).toHaveLength(1);
  expect(snapshot).toMatchObject({
    coverage: "partial",
    coverage_message: value.coverage_message,
  });
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.deliveries()).toEqual([snapshot]);
});

test("capacity and source path limits fail closed", () => {
  expect(() =>
    journal.touch({ ...source, chat_path: "/home/user/../etc/chat.chat" }),
  ).toThrow(/invalid/);
  expect(() => journal.sources("", 101)).toThrow(/limit/);
  const small = new CollaborationJournal(":memory:", { sources: 1, bytes: 10 });
  try {
    small.touch(source);
    expect(() =>
      small.touch({ ...source, chat_path: "/home/user/other.chat" }),
    ).toThrow(/capacity/);
    small.registered(small.registrations()[0], "epoch");
    expect(() => small.prepare(small.scans()[0], read())).toThrow(/capacity/);
  } finally {
    small.close();
  }
});

test("room deletion and replacement protection survives service restart", () => {
  expect(journal.roomState(source.project_id, "room-1")).toBe(false);
  journal.initializedRoom(source.project_id, "room-1");
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.roomState(source.project_id, "room-1")).toBe(true);
  expect(() => journal.roomState(source.project_id, "room-2")).toThrow(
    /replacement/,
  );
});

test("fresh room intent survives lost disk ACK but not completion, relocation, or restore generation", () => {
  const room = "22222222-2222-4222-8222-222222222222";
  expect(journal.pendingRoomInitialization(source, room, 0)).toBe(false);
  journal.beginRoomInitialization(source, room, 0);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.pendingRoomInitialization(source, room, 0)).toBe(true);
  expect(journal.pendingRoomInitialization(source, room, 1)).toBe(false);
  expect(
    journal.pendingRoomInitialization(
      { ...source, chat_path: "/home/user/moved.chat" },
      room,
      0,
    ),
  ).toBe(false);
  journal.beginRoomInitialization(source, room, 1);
  expect(journal.pendingRoomInitialization(source, room, 1)).toBe(false);
  journal.initializedRoom(source.project_id, room);
  expect(journal.pendingRoomInitialization(source, room, 0)).toBe(false);
  expect(() => journal.beginRoomInitialization(source, room, 0)).toThrow(
    /already initialized/,
  );
});

test("rename intent survives restart and preserves activity only after owner locator acknowledgement", () => {
  register();
  const first = prepare();
  journal.acknowledge(first);
  const to = { ...source, chat_path: "/home/user/moved.chat" };
  const operation = journal.beginRelocation(source, to.chat_path);
  journal.finishRelocation(operation, true);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  expect(journal.relocations()).toEqual([
    {
      operation_id: operation,
      project_id: source.project_id,
      from_path: source.chat_path,
      to_path: to.chat_path,
      state: "ready",
    },
  ]);
  for (const registration of journal.registrations())
    journal.registered(registration, "destination-epoch");
  expect(journal.scans()).toEqual([]);
  journal.acknowledgeRelocation(operation, "destination-epoch");
  const scan = journal.scans().find((s) => s.chat_path === to.chat_path)!;
  expect(
    journal.prepare(scan, {
      ...read(),
      resources: read().resources.map((r) => ({
        ...r,
        chat_path: to.chat_path,
      })),
    }),
  ).toBe(true);
  expect(journal.deliveries()[0].resources[0].activity).toBe(1);
  expect(journal.relocations()).toEqual([]);
});

test("unknown rename outcome remains fenced and copied IDs cannot steal old links", () => {
  register();
  journal.acknowledge(prepare());
  const to = { ...source, chat_path: "/home/user/copied.chat" };
  journal.touch(to);
  journal.registered(journal.registrations()[0], "copy-epoch");
  const copy = journal.scans().find((s) => s.chat_path === to.chat_path)!;
  expect(() =>
    journal.prepare(copy, {
      ...read(),
      resources: read().resources.map((r) => ({
        ...r,
        chat_path: to.chat_path,
      })),
    }),
  ).toThrow(/identity conflict/);
  const operation = journal.beginRelocation(source, to.chat_path);
  journal.finishRelocation(operation, false);
  expect(() => journal.acknowledgeRelocation(operation)).toThrow(
    /reconciliation/,
  );
  expect(journal.scans()).toEqual([]);
});

test("copy provenance fences a destination even before original chat was indexed", () => {
  const to = { ...source, chat_path: "/home/user/a-copy.chat" };
  journal.copied(to, source.chat_path);
  journal.registered(journal.registrations()[0], "copy-epoch");
  expect(journal.scans()).toEqual([]);
});
