import {
  withChatIdentityArchive,
  readChatRelationArchive,
} from "@cocalc/backend/chat-store/sqlite-offload";
import { readCollaborationSource } from "./filesystem";
import { migrateLegacyChatSource } from "./legacy-identity-source";
import { resolveChatIdentityRows } from "@cocalc/util/collaboration-chat-identity";
const createChatSyncDB = jest.fn();
jest.mock("@cocalc/backend/chat-store/sqlite-offload", () => ({
  withChatIdentityArchive: jest.fn(),
  readChatRelationArchive: jest.fn(),
}));
jest.mock("./flush-history", () => ({
  assertCanonicalRoomHistoryBound: jest.fn(),
}));
jest.mock("./filesystem", () => ({
  readCollaborationSource: jest.fn(),
  collaborationCopySourceFingerprint: (rows) => JSON.stringify(rows),
}));
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/legacy.chat",
};
const root = {
  event: "chat",
  sender_id: "alice",
  date: "2026-09-27T00:00:00.000Z",
  history: [],
};
function fixture() {
  const rows: any[] = [root];
  const db = {
    get: () => rows,
    isReady: () => true,
    set: jest.fn((row) => rows.push(row)),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
  (createChatSyncDB as jest.Mock).mockReturnValue(db);
  (readCollaborationSource as jest.Mock).mockResolvedValue([root]);
  (withChatIdentityArchive as jest.Mock).mockImplementation(
    async (_opts, run) =>
      run({
        migration_id: source.project_id,
        rows: [],
        project: jest.fn(async () => {}),
      }),
  );
  const fs = {
    lstat: jest.fn(async () => ({ isFile: () => true })),
    safeAbsPath: jest.fn(async () => "/volume/legacy.chat"),
    canonicalSyncIdentityPath: jest.fn(async () => source.chat_path),
  };
  return {
    db,
    rows,
    options: {
      source,
      fs: fs as any,
      client: {} as any,
      createSyncDB: createChatSyncDB,
      assertCurrent: jest.fn(async () => {}),
    },
  };
}
beforeEach(() => jest.clearAllMocks());
test("production adapter opens existing SyncDB and persists only mapping records", async () => {
  const f = fixture();
  await migrateLegacyChatSource(f.options);
  expect(
    f.db.set.mock.calls.every(([row]) => row.event === "chat-legacy-identity"),
  ).toBe(true);
  expect(f.rows[0]).toBe(root);
  expect(resolveChatIdentityRows(f.rows).messages).toHaveLength(1);
  expect(f.db.close).toHaveBeenCalledTimes(1);
  expect(f.options.assertCurrent.mock.calls.length).toBeGreaterThan(3);
  expect(withChatIdentityArchive).toHaveBeenCalledWith(
    { chat_path: "/volume/legacy.chat" },
    expect.any(Function),
  );
});
test("deleted sources never reopen history or recreate their files", async () => {
  const f = fixture();
  f.options.fs.lstat.mockRejectedValue(
    Object.assign(Error("missing"), { code: "ENOENT" }),
  );
  await migrateLegacyChatSource(f.options);
  expect(createChatSyncDB).not.toHaveBeenCalled();
  expect(withChatIdentityArchive).not.toHaveBeenCalled();
});
test("changed live message payload defers migration without writing", async () => {
  const f = fixture();
  f.rows[0] = { ...root, history: [{ content: "not saved yet" }] };
  await expect(migrateLegacyChatSource(f.options)).rejects.toThrow(
    "normal save required",
  );
  expect(f.db.set).not.toHaveBeenCalled();
  expect(f.db.close).toHaveBeenCalledTimes(1);
});
test("declared but unavailable archive history rejects before opening the document", async () => {
  const f = fixture();
  (readCollaborationSource as jest.Mock).mockResolvedValue([
    root,
    { event: "chat-thread-config", archived_chat_rows: 3 },
  ]);
  await expect(migrateLegacyChatSource(f.options)).rejects.toThrow(
    "archive evidence is incomplete",
  );
  expect(createChatSyncDB).not.toHaveBeenCalled();
});

test("production adapter reconciles a live reply with its archived root", async () => {
  const f = fixture();
  const reply = {
    ...root,
    date: "2026-09-27T00:00:01.000Z",
    reply_to: root.date,
  };
  f.rows.splice(0, f.rows.length, reply, {
    event: "chat-thread-config",
    thread_id: `legacy-thread-${Date.parse(root.date)}`,
    archived_chat_rows: 1,
  });
  (readCollaborationSource as jest.Mock).mockResolvedValue([...f.rows]);
  const project = jest.fn(async () => {});
  (withChatIdentityArchive as jest.Mock).mockImplementation(
    async (_opts, run) =>
      run({ migration_id: source.project_id, rows: [root], project }),
  );
  await migrateLegacyChatSource(f.options);
  const resolved = resolveChatIdentityRows([...f.rows, root]).messages;
  const rootIdentity = resolved.find((row) => row.raw === root)!;
  const replyIdentity = resolved.find((row) => row.raw === reply)!;
  expect(replyIdentity.thread_id).toBe(rootIdentity.thread_id);
  expect(replyIdentity.parent_message_id).toBe(rootIdentity.message_id);
  expect(rootIdentity.thread_id).toBe(`legacy-thread-${Date.parse(root.date)}`);
  expect(f.rows[0]).toBe(reply);
  expect(project).toHaveBeenCalledTimes(1);
});

test("native sources project archive indexes without opening or saving SyncDB", async () => {
  const f = fixture();
  (readCollaborationSource as jest.Mock).mockResolvedValue([
    { ...root, message_id: "native-message", thread_id: "native-thread" },
  ]);
  const project = jest.fn(async () => {});
  (withChatIdentityArchive as jest.Mock).mockImplementation(
    async (_opts, run) =>
      run({ migration_id: source.project_id, rows: [], project }),
  );
  await migrateLegacyChatSource(f.options);
  expect(createChatSyncDB).not.toHaveBeenCalled();
  expect(project).toHaveBeenCalledWith([]);
});
test("native-v2 archived edits and stale deletion counts bypass unnecessary migration", async () => {
  const f = fixture();
  const native = {
    ...root,
    schema_version: 2,
    message_id: "native",
    thread_id: "thread",
  };
  (readCollaborationSource as jest.Mock).mockResolvedValue([
    native,
    {
      event: "chat-thread-config",
      thread_id: "thread",
      archived_chat_rows: 100,
    },
  ]);
  (readChatRelationArchive as jest.Mock).mockReturnValue({
    registered: true,
    rows: [native, native],
  });
  await migrateLegacyChatSource(f.options);
  expect(withChatIdentityArchive).not.toHaveBeenCalled();
  expect(createChatSyncDB).not.toHaveBeenCalled();
  expect(f.options.assertCurrent).toHaveBeenCalledTimes(2);
});
