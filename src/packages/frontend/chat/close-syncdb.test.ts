import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import refCache from "@cocalc/util/refcache";
import {
  CHAT_CLOSE_SAVE_TIMEOUT_MS,
  CHAT_CLOSE_TIMEOUT_MS,
  closeChatSyncdb,
} from "./close-syncdb";

const mockWarn = jest.fn();
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({ warn: (...args) => mockWarn(...args) }),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeSyncdb(): any {
  const db = {
    project_id: "project",
    path: "room.chat",
    get_state: jest.fn(() => "ready"),
    is_read_only: jest.fn(() => false),
    has_unsaved_changes: jest.fn(() => true),
    save_to_disk: jest.fn(async () => {
      db.has_unsaved_changes.mockReturnValue(false);
    }),
    close: jest.fn(async () => {}),
  };
  return db;
}

beforeEach(() => mockWarn.mockClear());
afterEach(() => jest.useRealTimers());

test("waits for the captured dirty document to persist before closing once", async () => {
  const db = makeSyncdb();
  const saved = deferred();
  db.save_to_disk.mockImplementation(async () => {
    await saved.promise;
    db.has_unsaved_changes.mockReturnValue(false);
  });
  const done = closeChatSyncdb(db);
  expect(closeChatSyncdb(db)).toBe(done);
  await Promise.resolve();
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
  expect(db.close).not.toHaveBeenCalled();
  saved.resolve();
  await done;
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).not.toHaveBeenCalled();
});

test.each(["clean", "read-only", "connecting", "closed"])(
  "closes a %s document without an unnecessary disk write",
  async (state) => {
    const db = makeSyncdb();
    if (state === "clean") db.has_unsaved_changes.mockReturnValue(false);
    else if (state === "read-only") db.is_read_only.mockReturnValue(true);
    else db.get_state.mockReturnValue(state);
    await closeChatSyncdb(db);
    expect(db.save_to_disk).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
  },
);

test("resaves a later message after joining the first in-flight autosave", async () => {
  const db = makeSyncdb();
  const first = deferred();
  const second = deferred();
  let current = "first message";
  let disk = "";
  db.has_unsaved_changes.mockImplementation(() => disk !== current);
  const write = jest.fn(async () => {
    const snapshot = current;
    await (snapshot === "first message" ? first.promise : second.promise);
    disk = snapshot;
  });
  db.save_to_disk = jest.fn(reuseInFlight(write));
  const autosave = db.save_to_disk();
  current = "first and second messages";
  const done = closeChatSyncdb(db);
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  first.resolve();
  await autosave;
  // Drain the save/deadline promises before asserting the second write started.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(2);
  expect(db.close).not.toHaveBeenCalled();
  second.resolve();
  await done;
  expect(disk).toBe("first and second messages");
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).not.toHaveBeenCalled();
});

test("reports save failure but still closes without rejecting cleanup", async () => {
  const db = makeSyncdb();
  db.save_to_disk.mockRejectedValue(Error("disconnected"));
  await expect(closeChatSyncdb(db)).resolves.toBeUndefined();
  expect(db.save_to_disk).toHaveBeenCalledTimes(3);
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledWith(
    "chat disk save during teardown failed",
    expect.objectContaining({ error: "Error: disconnected" }),
  );
});

test("retries a rejected older save while retaining the dirty document", async () => {
  jest.useFakeTimers();
  const db = makeSyncdb();
  db.save_to_disk.mockRejectedValueOnce(
    Error("collaborative history is not up to date"),
  );
  const done = closeChatSyncdb(db);
  await jest.advanceTimersByTimeAsync(0);
  expect(db.close).not.toHaveBeenCalled();
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(250);
  await done;
  expect(db.save_to_disk).toHaveBeenCalledTimes(2);
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).not.toHaveBeenCalled();
});

test("bounds repeated dirty writes rather than spinning forever", async () => {
  const db = makeSyncdb();
  db.save_to_disk.mockResolvedValue(undefined);
  await closeChatSyncdb(db);
  expect(db.save_to_disk).toHaveBeenCalledTimes(3);
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledTimes(1);
});

test("bounds a stalled save and contains its late rejection", async () => {
  jest.useFakeTimers();
  const db = makeSyncdb();
  const stalled = deferred();
  db.save_to_disk.mockReturnValue(stalled.promise);
  const done = closeChatSyncdb(db);
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(CHAT_CLOSE_SAVE_TIMEOUT_MS);
  await done;
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledTimes(1);
  stalled.reject(Error("late network failure"));
  await Promise.resolve();
  expect(jest.getTimerCount()).toBe(0);
});

test("bounds a stalled close without touching another document", async () => {
  jest.useFakeTimers();
  const db = makeSyncdb();
  db.has_unsaved_changes.mockReturnValue(false);
  db.close.mockReturnValue(new Promise(() => {}));
  const done = closeChatSyncdb(db);
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(CHAT_CLOSE_TIMEOUT_MS);
  await done;
  expect(mockWarn).toHaveBeenCalledWith(
    "chat syncdb close failed",
    expect.objectContaining({ error: "Error: chat teardown close timed out" }),
  );
  expect(jest.getTimerCount()).toBe(0);
});

test("delayed old close releases only its lease on same-path Conat tables", async () => {
  const closeTable = jest.fn();
  const tables = refCache<{ path: string; noCache?: boolean }, any>({
    name: "chat-close-reopen-test",
    createObject: async () => ({ close: closeTable }),
  });
  const oldTable = await tables({ path: "room.chat" });
  const old = makeSyncdb();
  const saved = deferred();
  old.save_to_disk.mockImplementation(async () => {
    await saved.promise;
    old.has_unsaved_changes.mockReturnValue(false);
  });
  old.close.mockImplementation(() => oldTable.close());
  const done = closeChatSyncdb(old);
  const reopenedTable = await tables({ path: "room.chat" });
  expect(reopenedTable).toBe(oldTable);
  saved.resolve();
  await done;
  expect(closeTable).not.toHaveBeenCalled();
  expect(tables.size()).toBe(1);
  reopenedTable.close();
  expect(closeTable).toHaveBeenCalledTimes(1);
  expect(tables.size()).toBe(0);
});
