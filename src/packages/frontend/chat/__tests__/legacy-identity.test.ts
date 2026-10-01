/** @jest-environment jsdom */
import { EventEmitter } from "events";
import { ChatMessageCache } from "../message-cache";
import {
  chatIdentityMutation,
  planChatIdentityMigration,
  resolveChatIdentityRows,
} from "@cocalc/util/collaboration-chat-identity";
const migration_id = "11111111-1111-4111-8111-111111111111";
const root = {
  event: "chat",
  sender_id: "alice",
  date: "2026-09-27T00:00:00.000Z",
  history: [],
};
const reply = {
  event: "chat",
  sender_id: "bob",
  date: "2026-09-27T00:00:00.001Z",
  reply_to: root.date,
  history: [],
};
class DB extends EventEmitter {
  opts = { ignoreInitialChanges: true };
  constructor(public rows: any[]) {
    super();
  }
  get_state() {
    return "ready";
  }
  get() {
    return this.rows;
  }
  get_one(where: Record<string, unknown>) {
    return this.rows.find((r) =>
      Object.entries(where).every(([k, v]) => r[k] === v),
    );
  }
}

test("initial, live, archive and edit paths use one persisted legacy identity", () => {
  const markers = planChatIdentityMigration([root, reply], {
    migration_id,
    history_complete: true,
  });
  const db = new DB([root, ...markers]);
  const cache = new ChatMessageCache(db as any);
  const expected = resolveChatIdentityRows([root, reply, ...markers]).messages;
  expect(cache.getByMessageId(expected[0].message_id)?.thread_id).toBe(
    expected[0].thread_id,
  );
  cache.hydrateArchivedRows([reply]);
  expect(cache.getByMessageId(expected[1].message_id)?.parent_message_id).toBe(
    expected[0].message_id,
  );
  expect(cache.getThreadIndex().size).toBe(1);
  const projected = cache.getByMessageId(expected[0].message_id)!;
  const patch = chatIdentityMutation(db.get(), {
    ...projected,
    history: [{ content: "edit" }],
  });
  expect(patch.message_id).toBeUndefined();
  expect(patch.thread_id).toBeUndefined();
  expect(db.get_one(patch)).toBeUndefined(); // payload fields are not lookup keys
  db.rows[0] = { ...root, ...patch };
  db.emit(
    "change",
    new Set([{ event: "chat", date: root.date, sender_id: root.sender_id }]),
  );
  expect(
    cache.getByMessageId(expected[0].message_id)?.history?.[0]?.content,
  ).toBe("edit");
  expect(db.rows.filter((r) => r.event === "chat")).toHaveLength(1);
  cache.dispose();
});

test("partial markers retain confirmed views and manifest delivery rebuilds", () => {
  const markers = planChatIdentityMigration([root, reply], {
    migration_id,
    history_complete: true,
  });
  const db = new DB([root, reply, ...markers]);
  const cache = new ChatMessageCache(db as any);
  const ids = [...cache.getMessagesById().keys()];
  db.rows = [root, reply, markers[0]];
  db.emit("change", new Set([markers[1]]));
  expect([...cache.getMessagesById().keys()]).toEqual(ids);
  expect(cache.debugState().identityError).toContain("incomplete_marker");
  db.rows.push(markers[1]);
  db.emit("change", new Set([markers[1]]));
  expect(cache.debugState().identityError).toBeUndefined();
  expect([...cache.getMessagesById().keys()]).toEqual(ids);
  cache.dispose();
});
