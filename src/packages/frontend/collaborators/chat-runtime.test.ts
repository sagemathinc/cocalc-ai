import { EventEmitter } from "events";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { waitForCollaborationChat } from "./chat-runtime";

function actions() {
  const db = Object.assign(new EventEmitter(), { get_state: () => "init" });
  return { db, chat: { syncdb: db } as unknown as ChatActions };
}
test("cancelling a selected chat releases all listeners", async () => {
  const { db, chat } = actions();
  const abort = new AbortController();
  const ready = waitForCollaborationChat(chat, abort.signal);
  abort.abort();
  await expect(ready).rejects.toThrow("cancelled");
  expect(db.eventNames()).toEqual([]);
});
test("ready and failure release listeners without keeping a timer alive", async () => {
  const first = actions();
  const ready = waitForCollaborationChat(
    first.chat,
    new AbortController().signal,
  );
  first.db.emit("ready");
  await ready;
  expect(first.db.eventNames()).toEqual([]);
  const second = actions();
  const failed = waitForCollaborationChat(
    second.chat,
    new AbortController().signal,
  );
  second.db.emit("error", Error("Access removed"));
  await expect(failed).rejects.toThrow("Access removed");
  expect(second.db.eventNames()).toEqual([]);
});
