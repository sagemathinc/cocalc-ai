import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationJournal } from "./journal";

const previous = {
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  chat_path: "/home/user/old.chat",
  initialized: true,
};
const next = {
  ...previous,
  room_id: "33333333-3333-4333-8333-333333333333",
  chat_path: "/home/user/new.chat",
  initialized: false,
};
let journal: CollaborationJournal;
beforeEach(() => {
  journal = new CollaborationJournal(":memory:");
});
afterEach(() => journal.close());

test("replacement resets only room initialization and permanently stops old pending work", () => {
  journal.initializedRoom(previous.project_id, previous.room_id);
  journal.touch(previous);
  expect(journal.registrations()).toHaveLength(1);
  journal.replaceRoom(previous, next);
  expect(journal.roomState(next.project_id, next.room_id)).toBe(false);
  expect(journal.registrations()).toHaveLength(0);
  expect(() => journal.beginWrite(previous)).toThrow("retired");
  expect(() =>
    journal.initializedRoom(previous.project_id, previous.room_id),
  ).toThrow("retired");
  journal.initializedRoom(next.project_id, next.room_id);
  journal.replaceRoom(previous, next);
  expect(journal.roomState(next.project_id, next.room_id)).toBe(true);
});

test("owner-confirmed retirement reconciles a journal that missed multiple replacement acknowledgements", () => {
  const third = {
    ...next,
    room_id: "44444444-4444-4444-8444-444444444444",
    chat_path: "/home/user/third.chat",
  };
  journal.initializedRoom(previous.project_id, previous.room_id);
  journal.reconcileRoom({
    ...third,
    retired_rooms: [previous, next].map(({ room_id, chat_path }) => ({
      room_id,
      chat_path,
    })),
  });
  expect(journal.roomState(third.project_id, third.room_id)).toBe(false);
  expect(() => journal.beginWrite(previous)).toThrow("retired");
  expect(() => journal.beginWrite(next)).toThrow("retired");
  expect(() =>
    journal.roomState(previous.project_id, previous.room_id),
  ).toThrow("retired");
});

test("retirement releases admitted pages and unbound relation drafts, but not unrelated sources", async () => {
  journal.touch(previous);
  journal.registered(journal.registrations()[0], next.room_id);
  const scan = journal.scans()[0];
  const native = {
    kind: "conversation" as const,
    resource_id: "thread",
    thread_id: "thread",
  };
  const relation = {
    kind: "participant" as const,
    source: native,
    account_id: previous.project_id,
  };
  const admitted = journal.relations.begin(scan);
  journal.relations.append(admitted, [relation]);
  journal.relations.seal(admitted);
  journal.prepare(scan, {
    resources: [
      {
        ...previous,
        ...native,
        title: "Discussion",
        participant_ids: [],
        activity: 0,
        created_at: 0,
        updated_at: 0,
      },
    ],
    activity_ids: {},
    relation_draft: admitted,
  });
  const delivery = journal.deliveries()[0];
  await expect(
    journal.relations.deliver(delivery, {
      stage: async () => {
        throw Error("connection lost");
      },
      commit: jest.fn(),
    }),
  ).rejects.toThrow("connection lost");
  const unfinished = journal.relations.begin(scan);
  journal.relations.append(unfinished, [relation]);
  const other = journal.relations.begin({
    ...scan,
    chat_path: "/home/user/unrelated.chat",
  });
  journal.relations.append(other, [relation]);
  const db = (journal as any).db;
  expect(
    db.prepare("SELECT count(*) AS n FROM relation_pages").get().n,
  ).toBeGreaterThan(0);
  journal.replaceRoom(previous, next);
  expect(db.prepare("SELECT draft_id FROM relation_drafts").all()).toEqual([
    { draft_id: other },
  ]);
  expect(db.prepare("SELECT draft_id FROM relation_rows").all()).toEqual([
    { draft_id: other },
  ]);
  expect(db.prepare("SELECT count(*) AS n FROM relation_pages").get().n).toBe(
    0,
  );
  expect(journal.deliveries()).toEqual([]);
  expect(journal.roomState(next.project_id, next.room_id)).toBe(false);
});

test("replacement lock rejects in-flight writes and blocks new writes until released", async () => {
  const token = journal.beginWrite(previous);
  const run = jest.fn();
  await expect(journal.withRoomReplacementLock(previous, run)).rejects.toThrow(
    "pending writes",
  );
  expect(run).not.toHaveBeenCalled();
  journal.finishWrite(token);
  await expect(
    journal.withRoomReplacementLock(previous, async () => {
      expect(() => journal.beginWrite(previous)).toThrow("replacing");
      throw Error("owner CAS failed");
    }),
  ).rejects.toThrow("owner CAS failed");
  journal.finishWrite(journal.beginWrite(previous));
});

test("a retired source remains replay-lockable but not writable", async () => {
  journal.replaceRoom(previous, next);
  await journal.withRoomReplacementLock(previous, async () =>
    journal.replaceRoom(previous, next),
  );
  expect(() => journal.beginWrite(previous)).toThrow("retired");
});

test("discovery and census skip retirement instead of blocking unrelated sources", () => {
  journal.replaceRoom(previous, next);
  journal.touch(previous);
  expect(journal.acceptCensusCandidate({ ...previous, run_id: "rescan" })).toBe(
    false,
  );
  journal.touch(next);
  expect(journal.registrations().map((row) => row.chat_path)).toEqual([
    next.chat_path,
  ]);
});

test("retired markers restored at another locator cannot rearm history", () => {
  journal.replaceRoom(previous, next);
  expect(() =>
    journal.prepare(
      { ...next, epoch: previous.room_id, generation: 0 },
      {
        resources: [],
        activity_ids: {},
        notification_room_id: previous.room_id,
      },
    ),
  ).toThrow("retired");
});

test("an in-flight unmarked source read cannot recreate retired metadata delivery", () => {
  journal.touch(previous);
  const registration = journal.registrations()[0];
  journal.registered(registration, next.room_id);
  const scan = journal.scans()[0];
  journal.replaceRoom(previous, next);
  expect(journal.prepare(scan, { resources: [], activity_ids: {} })).toBe(
    false,
  );
  expect(journal.deliveries()).toEqual([]);
});

test("later replacement is not undone by an old local transition callback", () => {
  const third = {
    ...next,
    room_id: "44444444-4444-4444-8444-444444444444",
    chat_path: "/home/user/third.chat",
  };
  journal.replaceRoom(previous, next);
  journal.replaceRoom(next, third);
  expect(() => journal.replaceRoom(previous, next)).toThrow("retired");
  expect(journal.roomState(third.project_id, third.room_id)).toBe(false);
});

test("retirement and replacement initialization state survive journal restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "room-replacement-journal-"));
  let persistent = new CollaborationJournal(join(directory, "journal.sqlite"));
  try {
    persistent.replaceRoom(previous, next);
    persistent.initializedRoom(next.project_id, next.room_id);
    persistent.close();
    persistent = new CollaborationJournal(join(directory, "journal.sqlite"));
    expect(() => persistent.beginWrite(previous)).toThrow("retired");
    expect(persistent.roomState(next.project_id, next.room_id)).toBe(true);
    persistent.replaceRoom(previous, next);
    expect(persistent.roomState(next.project_id, next.room_id)).toBe(true);
  } finally {
    persistent.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
