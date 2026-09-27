import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationJournal, type CollaborationRead } from "./journal";
import { collectCollaborationRelationDraft } from "./relations";
import { COLLABORATION_MAX_SOURCE_BYTES } from "@cocalc/util/collaborators";
import type {
  CollaborationRelationManifest,
  CollaborationRelationPage,
} from "@cocalc/util/collaboration-relations";

const source = { project_id: randomUUID(), chat_path: "/home/user/room.chat" };
const room = randomUUID(),
  actor = randomUUID();
const native = {
  kind: "conversation" as const,
  resource_id: "thread",
  thread_id: "thread",
};
let journal: CollaborationJournal, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-relations-journal-"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  journal.touch(source);
  journal.registered(journal.registrations()[0], randomUUID());
  journal.armNotifications(source, room);
});
afterEach(() => {
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
async function prepare(count = 1) {
  const scan = journal.scans()[0];
  const ids = Array.from({ length: count }, (_, i) => `message-${i}`);
  const read: CollaborationRead = {
    resources: [
      {
        ...source,
        ...native,
        title: "Chat",
        participant_ids: [],
        created_at: 0,
        updated_at: 0,
        activity: 0,
      },
    ],
    activity_ids: { thread: ids },
    notification_room_id: room,
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
    relation_draft: await collectCollaborationRelationDraft(
      journal.relations,
      scan,
      [{ kind: "participant", source: native, account_id: actor }],
      () => true,
    ),
  };
  expect(journal.prepare(scan, read)).toBe(true);
  return journal.deliveries()[0];
}
function receiver() {
  return {
    stage: jest.fn(async (_page: CollaborationRelationPage) => {}),
    commit: jest.fn(async (_manifest: CollaborationRelationManifest) => {}),
  };
}

test("journal writer recovery rebinds frozen relations with the retained notification delivery", async () => {
  const before = await prepare();
  const remote = receiver();
  await journal.relations.deliver(before, remote);
  journal.reassign(source, randomUUID());
  journal.relations.recover();
  journal.registered(journal.registrations()[0], randomUUID());
  const after = journal.deliveries()[0];
  expect(after.notification_events).toEqual(before.notification_events);
  expect(journal.relations.has(before)).toBe(false);
  expect(journal.relations.has(after)).toBe(true);
  await journal.relations.deliver(after, remote);
  expect(remote.stage.mock.calls[1][0].rows).toEqual(
    remote.stage.mock.calls[0][0].rows,
  );
  expect(remote.stage.mock.calls[1][0].digest).not.toBe(
    remote.stage.mock.calls[0][0].digest,
  );
  expect(remote.commit.mock.calls[1][0].snapshot.epoch).toBe(after.epoch);
  journal.acknowledge(before);
  expect(journal.relations.has(after)).toBe(true);
  journal.acknowledge(after);
  expect(journal.relations.has(after)).toBe(false);
});

test("mediated relocation and restart retain pending relation facts under the admitted new locator", async () => {
  const before = await prepare();
  const remote = receiver();
  await journal.relations.deliver(before, remote);
  const operation = journal.beginRelocation(source, "/home/user/moved.chat");
  journal.finishRelocation(operation, true);
  const epoch = randomUUID();
  journal.acknowledgeRelocation(operation, epoch);
  journal.close();
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  journal.relations.recover();
  const after = journal.deliveries()[0];
  expect(after).toMatchObject({ chat_path: "/home/user/moved.chat", epoch });
  expect(journal.relations.has(after)).toBe(true);
  await journal.relations.deliver(after, remote);
  expect(remote.commit.mock.calls[1][0].snapshot).toMatchObject({
    chat_path: after.chat_path,
    epoch,
  });
  expect(remote.stage.mock.calls[1][0].rows).toEqual(
    remote.stage.mock.calls[0][0].rows,
  );
  journal.acknowledge(after);
  expect(journal.relations.has(after)).toBe(false);
});

test("notification batches advance metadata sequence without replacing the complete relation set", async () => {
  const first = await prepare(101);
  const remote = receiver();
  await journal.relations.deliver(first, remote);
  journal.acknowledge(first);
  const next = journal.deliveries()[0];
  expect(next.sequence).toBe(first.sequence + 1);
  expect(next.notification_events).toHaveLength(1);
  expect(journal.relations.has(next)).toBe(true);
  await journal.relations.deliver(next, remote);
  expect(remote.stage).toHaveBeenCalledTimes(1);
  expect(remote.commit.mock.calls[1][0]).toEqual(
    remote.commit.mock.calls[0][0],
  );
  journal.acknowledge(next);
  expect(journal.deliveries()).toEqual([]);
  expect(journal.relations.has(next)).toBe(false);
});
test("journal admission reserves wire capacity for the complete relation manifest", () => {
  const scan = journal.scans()[0];
  const read = {
    resources: [
      {
        ...source,
        ...native,
        title: "x".repeat(COLLABORATION_MAX_SOURCE_BYTES - 2048),
        participant_ids: [],
        activity: 0,
        created_at: 0,
        updated_at: 0,
      },
    ],
    activity_ids: {},
  };
  const relation_draft = journal.relations.seal(journal.relations.begin(scan));
  expect(() => journal.prepare(scan, { ...read, relation_draft })).toThrow(
    "snapshot byte capacity",
  );
  expect(journal.deliveries()).toEqual([]);
  expect(journal.prepare(scan, read)).toBe(true);
});
