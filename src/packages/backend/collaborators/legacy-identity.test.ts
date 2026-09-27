import { migrateLegacyChatIdentities } from "./legacy-identity";
import { resolveChatIdentityRows } from "@cocalc/util/collaboration-chat-identity";

const migration_id = "11111111-1111-4111-8111-111111111111";
const root = {
  event: "chat",
  sender_id: "alice",
  date: "2026-09-27T00:00:00.000Z",
  history: [{ content: "original" }],
};
const reply = {
  event: "chat",
  sender_id: "bob",
  date: "2026-09-27T00:00:00.001Z",
  reply_to: root.date,
};
function fixture(initial: Record<string, any>[] = [root, reply]) {
  const rows = [...initial];
  const writes: any[] = [];
  const events: string[] = [];
  const db = {
    get: () => rows,
    set: jest.fn((row) => {
      writes.push(row);
      events.push(row.record_type);
      const i = rows.findIndex(
        (r) => r.event === row.event && r.thread_id === row.thread_id,
      );
      if (i < 0) rows.push(row);
      else rows[i] = row;
    }),
    commit: jest.fn(),
    save: jest.fn(async () => {
      events.push("save");
    }),
    save_to_disk: jest.fn(async () => {
      events.push("disk");
    }),
  };
  const options = {
    db,
    migration_id,
    archived_rows: [],
    history_complete: true,
    assertCurrent: jest.fn(async () => {}),
    projectArchive: jest.fn(async () => {
      events.push("archive");
    }),
  };
  return { rows, writes, events, options };
}

test("only additive marker writes, archive projection precedes committed manifest", async () => {
  const f = fixture();
  await migrateLegacyChatIdentities(f.options);
  expect(f.rows.slice(0, 2)).toEqual([root, reply]);
  expect(f.writes.every((row) => row.event === "chat-legacy-identity")).toBe(
    true,
  );
  expect(f.events).toEqual([
    "chunk",
    "save",
    "disk",
    "archive",
    "manifest",
    "save",
    "disk",
  ]);
  expect(resolveChatIdentityRows(f.rows).messages[1].parent_message_id).toBe(
    resolveChatIdentityRows(f.rows).messages[0].message_id,
  );
  f.writes.length = 0;
  expect((await migrateLegacyChatIdentities(f.options)).changed).toBe(false);
  expect(f.writes).toEqual([]);
  expect(f.options.projectArchive).toHaveBeenCalledTimes(2);
});

test("archive-only roots can be mapped without restoring message rows into the head", async () => {
  const f = fixture([reply]);
  await migrateLegacyChatIdentities({ ...f.options, archived_rows: [root] });
  expect(f.rows.filter((row) => row.event === "chat")).toEqual([reply]);
  expect(resolveChatIdentityRows(f.rows).messages).toHaveLength(1);
});

test("incomplete history is deferred before any writes", async () => {
  const f = fixture([reply]);
  await expect(
    migrateLegacyChatIdentities({ ...f.options, history_complete: false }),
  ).rejects.toThrow("history_required");
  expect(f.writes).toEqual([]);
});

test("archive failure leaves unreadable chunks and retry commits the identical mapping", async () => {
  const f = fixture();
  f.options.projectArchive.mockRejectedValueOnce(Error("archive unavailable"));
  await expect(migrateLegacyChatIdentities(f.options)).rejects.toThrow(
    "archive unavailable",
  );
  const chunk = f.writes[0];
  expect(() => resolveChatIdentityRows(f.rows)).toThrow("incomplete_marker");
  await migrateLegacyChatIdentities(f.options);
  expect(f.writes[1]).toEqual(chunk);
  expect(resolveChatIdentityRows(f.rows).messages).toHaveLength(2);
});

test("a lost final disk acknowledgement retries persistence rather than remapping", async () => {
  const f = fixture();
  f.options.db.save_to_disk
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("lost ack"));
  await expect(migrateLegacyChatIdentities(f.options)).rejects.toThrow(
    "lost ack",
  );
  const before = resolveChatIdentityRows(f.rows).messages;
  await migrateLegacyChatIdentities(f.options);
  expect(resolveChatIdentityRows(f.rows).messages).toEqual(before);
  expect(f.options.db.save_to_disk).toHaveBeenCalledTimes(3);
});

test("changed source after chunk save cannot publish a manifest", async () => {
  const f = fixture();
  f.options.projectArchive.mockImplementationOnce(async () => {
    f.rows[1] = { ...reply, reply_to: null };
  });
  await expect(migrateLegacyChatIdentities(f.options)).rejects.toThrow(
    "changed_source",
  );
  expect(f.writes.some((row) => row.record_type === "manifest")).toBe(false);
});
