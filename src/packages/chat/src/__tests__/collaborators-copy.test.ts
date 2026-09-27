import {
  collaborationCopyFingerprint,
  initializeCollaborationCopy,
  extractCollaborationMetadata,
} from "../collaborators";
import { humanRoomMarker } from "../collaborators-room";
const project_id = "11111111-1111-4111-8111-111111111111";
const operation_id = "22222222-2222-4222-8222-222222222222";
const another = "33333333-3333-4333-8333-333333333333";
const source = { project_id, chat_path: "/home/user/original.chat" };
function fixture() {
  const rows: Record<string, any>[] = [
    {
      event: "chat-thread-config",
      thread_id: "human",
      agent_kind: "none",
      name: "A conversation",
      notification_followers: [project_id],
      notification_muted: [another],
    },
    {
      event: "chat-thread-config",
      thread_id: "agent",
      agent_kind: "acp",
      acp_config: { identity: "original" },
    },
    {
      event: "chat",
      message_id: "message",
      thread_id: "human",
      sender_id: project_id,
      history: [{ content: "original authored text" }],
    },
  ];
  const db = {
    get: () => rows,
    set: jest.fn((row) => {
      const index = rows.findIndex((r) => r.event === "collaborators-identity");
      if (index < 0) rows.push(row);
      else rows[index] = row;
    }),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () => {}),
  };
  return { db, rows };
}
test("copy namespace changes resource identities without editing native IDs, content or agent configuration", async () => {
  const { db, rows } = fixture();
  const original = structuredClone(rows);
  const before = extractCollaborationMetadata(rows, source);
  await initializeCollaborationCopy(db, {
    operation_id,
    fingerprint: collaborationCopyFingerprint(rows),
  });
  expect(rows.slice(0, -1)).toEqual(original);
  const after = extractCollaborationMetadata(rows, {
    ...source,
    chat_path: "/home/user/copy.chat",
  });
  expect(
    after.resources.every(
      (r) => !before.resources.some((v) => v.resource_id === r.resource_id),
    ),
  ).toBe(true);
  expect(after.resources.map((r) => r.thread_id).sort()).toEqual([
    "agent",
    "human",
  ]);
  expect(
    after.resources.find((r) => r.kind === "agent")?.agent_id,
  ).toBeUndefined();
  expect(
    before.resources.find((r) => r.kind === "conversation"),
  ).toHaveProperty("notification_muted", [another]);
  expect(
    after.resources.every(
      (r) => !("notification_followers" in r) && !("notification_muted" in r),
    ),
  ).toBe(true);
  expect(
    extractCollaborationMetadata(rows, source).resources.map(
      (r) => r.resource_id,
    ),
  ).toEqual(after.resources.map((r) => r.resource_id));
  expect(() => humanRoomMarker(db, { ...source, room_id: another })).toThrow(
    /copied/,
  );
});
test("copy operation retries the same marker/save and nested copies allocate another namespace", async () => {
  const { db, rows } = fixture();
  const fingerprint = collaborationCopyFingerprint(rows);
  db.save_to_disk.mockRejectedValueOnce(Error("lost ack"));
  await expect(
    initializeCollaborationCopy(db, { operation_id, fingerprint }),
  ).rejects.toThrow(/ack/);
  await initializeCollaborationCopy(db, { operation_id, fingerprint });
  expect(db.set).toHaveBeenCalledTimes(1);
  const before = extractCollaborationMetadata(rows, source);
  await initializeCollaborationCopy(db, {
    operation_id: another,
    fingerprint: collaborationCopyFingerprint(rows),
  });
  expect(rows.filter((r) => r.event === "collaborators-identity")).toHaveLength(
    1,
  );
  expect(
    extractCollaborationMetadata(rows, source).resources[0].resource_id,
  ).not.toBe(before.resources[0].resource_id);
});
test("a changed or cached destination is never silently adopted", async () => {
  const { db, rows } = fixture();
  const fingerprint = collaborationCopyFingerprint(rows);
  rows[0].name = "changed meanwhile";
  await expect(
    initializeCollaborationCopy(db, { operation_id, fingerprint }),
  ).rejects.toThrow(/changed/);
  expect(db.set).not.toHaveBeenCalled();
  expect(collaborationCopyFingerprint(rows)).toBe(
    collaborationCopyFingerprint([...rows].reverse()),
  );
});
