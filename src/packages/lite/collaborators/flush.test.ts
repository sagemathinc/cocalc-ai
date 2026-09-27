/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { assertCanonicalRoomHistoryBound } from "@cocalc/backend/collaborators/flush-history";
import { createChatSyncDB } from "@cocalc/chat/server";
import {
  buildChatMessage,
  createHumanThread,
  initializeHumanRoom,
} from "@cocalc/chat";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import type { Client } from "@cocalc/conat/core/client";
import { createLiteCollaborators } from "./service";
import { flushLiteCanonicalRoom } from "./flush";

jest.mock("@cocalc/chat/server", () => ({ createChatSyncDB: jest.fn() }));
jest.mock("@cocalc/backend/collaborators/flush-history", () => ({
  assertCanonicalRoomHistoryBound: jest.fn(),
}));

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const thread_id = "33333333-3333-4333-8333-333333333333";
const message_id = "44444444-4444-4444-8444-444444444444";
const keys = ["date", "sender_id", "event", "message_id", "thread_id"];
const target = {
  project_id,
  account_id,
  kind: "conversation" as const,
  resource_id: thread_id,
};

async function fixture(initialized = true) {
  jest.mocked(assertCanonicalRoomHistoryBound).mockResolvedValue(undefined);
  const directory = mkdtempSync(join(tmpdir(), "lite-canonical-flush-"));
  let enabled = true;
  let now = Date.now();
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const client = {} as Client;
  const options = {
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    client,
    isEnabled: () => enabled,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  };
  let runtime = createLiteCollaborators(options);
  const createFilesystem = () =>
    runtime.wrapFilesystem(
      new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
      project_id,
    );
  let fs = createFilesystem();
  const room = await runtime.api.ensureRoom({ ...target, request_id: "room" });
  await runtime.ensureRoomDirectory(room);
  let doc = from_str("", keys, ["input"]);
  let history = "";
  const db = {
    get: () => doc.get(),
    set: (row) => {
      doc = doc.set(row);
    },
    commit() {},
    save: async () => {
      history = doc.to_str();
    },
    save_to_disk: async () => {
      await db.save();
      await fs.writeFile(room.chat_path, doc.to_str());
    },
  };
  await initializeHumanRoom(db, room);
  runtime.service.journal.armNotifications(room, room.room_id);
  await createHumanThread(db, {
    room,
    account_id,
    thread_id,
    title: "Durable human room",
  });
  if (initialized) {
    runtime.service.journal.initializedRoom(project_id, room.room_id);
    await runtime.store.markRoomInitialized({
      ...room,
      requesting_account_id: account_id,
    });
  }
  const sessions: {
    db: EventEmitter & {
      save: jest.Mock;
      save_to_disk: jest.Mock;
      close: jest.Mock;
      isReady: jest.Mock;
      get: () => readonly unknown[];
    };
    fs: SandboxedFilesystem;
  }[] = [];
  let onAcquire: (() => void) | undefined;
  let onSave: (() => Promise<void>) | undefined;
  jest.mocked(createChatSyncDB).mockImplementation((opts) => {
    // Substitute only the Conat transport. Replay its real serialized history;
    // filesystem saves, producer journals, extraction and SQLite are not mocked.
    const current = from_str(history, keys, ["input"]);
    const filesystem = opts.fs as SandboxedFilesystem;
    const baseContents = readFileSync(room.chat_path, "utf8");
    const session = Object.assign(new EventEmitter(), {
      get: () => current.get(),
      isReady: jest.fn(() => true),
      save: jest.fn(async () => onSave?.()),
      save_to_disk: jest.fn(async () => {
        await filesystem.writeFileDelta(room.chat_path, current.to_str(), {
          baseContents,
          saveLast: true,
        });
      }),
      close: jest.fn(async () => {}),
    });
    sessions.push({ db: session, fs: filesystem });
    onAcquire?.();
    return session as any;
  });
  return {
    get runtime() {
      return runtime;
    },
    get fs() {
      return fs;
    },
    room,
    sessions,
    set enabled(value: boolean) {
      enabled = value;
    },
    set onAcquire(value: (() => void) | undefined) {
      onAcquire = value;
    },
    set onSave(value: (() => Promise<void>) | undefined) {
      onSave = value;
    },
    async acceptedMessage(id = message_id) {
      db.set(
        buildChatMessage({
          prevHistory: [],
          date: new Date(now),
          sender_id: account_id,
          thread_id,
          message_id: id,
          content: "Accepted before abrupt browser exit. ".repeat(40),
          generating: false,
          schema_version: 2,
        }),
      );
      await db.save();
    },
    replaceHistory(rows: Record<string, unknown>[]) {
      history = rows
        .reduce((value, row) => value.set(row), from_str("", keys))
        .to_str();
    },
    disk() {
      return from_str(readFileSync(room.chat_path, "utf8"), keys).get();
    },
    async poll() {
      now += 120_000;
      await runtime.service.runOnce();
    },
    async restart() {
      fs.close();
      await runtime.close();
      runtime = createLiteCollaborators(options);
      fs = createFilesystem();
    },
    async flush() {
      const writer = await runtime.store.writerState(room);
      if (!writer) throw Error("test source is not registered");
      await flushLiteCanonicalRoom(
        { ...room, epoch: writer.epoch, generation: 0 },
        {
          ...options,
          store: runtime.store,
          journal: runtime.service.journal,
          createFilesystem,
        },
      );
    },
    async close() {
      fs.close();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
      jest.restoreAllMocks();
      jest.mocked(createChatSyncDB).mockReset();
      jest.mocked(assertCanonicalRoomHistoryBound).mockReset();
    },
  };
}

test("background flush recovers accepted serialized history after browser exit and daemon restart", async () => {
  const f = await fixture();
  try {
    await f.poll();
    expect((await f.runtime.api.getResource(target))?.activity).toBe(0);
    expect(f.sessions[0].db.save_to_disk).not.toHaveBeenCalled();
    const originalMtime = (await f.fs.stat(f.room.chat_path)).mtimeMs;
    await f.acceptedMessage();
    expect(f.disk().filter((row) => row.event === "chat")).toHaveLength(0);
    await f.restart();
    // No explicit touch or browser action: durable owner/journal discovery
    // eventually schedules the canonical source, including after restart.
    for (let i = 0; i < 4; i++) await f.poll();
    expect(f.disk().filter((row) => row.event === "chat")).toHaveLength(1);
    expect(await f.runtime.api.getResource(target)).toMatchObject({
      activity: 1,
      participant_ids: [account_id],
      participant_count: 1,
      personal: { read_through: 0 },
    });
    expect(
      (await f.runtime.api.listResources({ account_id, scope: "for-you" }))
        .items,
    ).toEqual([
      expect.objectContaining({
        resource_id: thread_id,
        reason: "participation",
      }),
    ]);
    expect(
      f.sessions.flatMap(({ db }) => db.save_to_disk.mock.calls),
    ).toHaveLength(1);
    expect((await f.fs.stat(f.room.chat_path)).mtimeMs).toBeGreaterThanOrEqual(
      originalMtime,
    );
    for (const { db } of f.sessions) expect(db.close).toHaveBeenCalledTimes(1);
    expect(createChatSyncDB).toHaveBeenCalledWith(
      expect.objectContaining({
        path: f.room.chat_path,
        project_id,
        noBackendFsWatch: true,
        fs: expect.any(SandboxedFilesystem),
      }),
    );
    expect(assertCanonicalRoomHistoryBound).toHaveBeenCalledWith({
      client: expect.anything(),
      project_id,
      path: await f.fs.canonicalSyncIdentityPath(f.room.chat_path),
    });
    await f.runtime.api.setPersonalState({
      ...target,
      patch: { following: false, muted: true, read_through: 1 },
    });
    await f.acceptedMessage("55555555-5555-4555-8555-555555555555");
    await f.restart();
    for (let i = 0; i < 4; i++) await f.poll();
    expect(await f.runtime.api.getResource(target)).toMatchObject({
      activity: 2,
      participant_count: 1,
      personal: { following: false, muted: true, read_through: 1 },
    });
    expect(
      f.sessions.flatMap(({ db }) => db.save_to_disk.mock.calls),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("disabled or uninitialized rooms and arbitrary indexed chats never open live history", async () => {
  const f = await fixture(false);
  try {
    await f.acceptedMessage();
    f.enabled = false;
    await f.poll();
    expect(createChatSyncDB).not.toHaveBeenCalled();
    f.enabled = true;
    await f.poll();
    await f.flush();
    expect(createChatSyncDB).not.toHaveBeenCalled();
    expect(f.disk().filter((row) => row.event === "chat")).toHaveLength(0);
    await f.fs.writeFile(
      "ordinary.chat",
      f
        .disk()
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    await f.poll();
    expect(createChatSyncDB).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("deleting an initialized room leaves a tombstone without recreating its directory or opening history", async () => {
  const f = await fixture();
  try {
    await f.poll();
    await f.acceptedMessage();
    const opened = f.sessions.length;
    await f.fs.rm(join(f.room.chat_path, ".."), { recursive: true });
    await f.poll();
    expect(f.sessions).toHaveLength(opened);
    expect(existsSync(f.room.chat_path)).toBe(false);
    expect(await f.runtime.api.getResource(target)).toBeNull();
    await f.restart();
    for (let i = 0; i < 4; i++) await f.poll();
    expect(existsSync(f.room.chat_path)).toBe(false);
    expect(f.sessions).toHaveLength(opened);
  } finally {
    await f.close();
  }
});

test("an initialized room does not authorize opening another source as live history", async () => {
  const f = await fixture();
  try {
    await f.poll();
    const opened = f.sessions.length;
    await flushLiteCanonicalRoom(
      {
        ...f.room,
        chat_path: join(f.room.chat_path, "..", "legacy.chat"),
        epoch: "other",
        generation: 0,
      },
      {
        project_id,
        account_id,
        client: {} as Client,
        store: f.runtime.store,
        journal: f.runtime.service.journal,
        createFilesystem: () => {
          throw Error("noncanonical source must not open a filesystem");
        },
      },
    );
    expect(f.sessions).toHaveLength(opened);
  } finally {
    await f.close();
  }
});

test.each([
  "disk-copy",
  "live-copy",
  "disk-marker",
  "live-marker",
  "deleted-during-acquire",
  "disabled-during-acquire",
])("%s is fenced without a disk save or activity advancement", async (mode) => {
  const f = await fixture();
  try {
    await f.poll();
    await f.acceptedMessage();
    const rows = f.disk();
    if (mode.endsWith("copy"))
      rows.push({ event: "collaborators-identity", operation_id: message_id });
    else if (mode.endsWith("marker"))
      rows.find((row) => row.event === "collaborators-room").room_id =
        message_id;
    if (mode.startsWith("disk"))
      await f.fs.writeFile(
        f.room.chat_path,
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
    else if (mode.startsWith("live")) f.replaceHistory(rows);
    else if (mode === "deleted-during-acquire")
      f.onAcquire = () => rmSync(f.room.chat_path);
    else
      f.onAcquire = () => {
        f.enabled = false;
      };
    await expect(f.flush()).rejects.toThrow();
    for (const { db } of f.sessions) {
      expect(db.save_to_disk).not.toHaveBeenCalled();
      expect(db.close).toHaveBeenCalledTimes(1);
    }
    f.enabled = true;
    expect((await f.runtime.api.getResource(target))?.activity).toBe(0);
    if (mode === "deleted-during-acquire")
      expect(existsSync(f.room.chat_path)).toBe(false);
  } finally {
    await f.close();
  }
});

test("save failure stays dirty across restart and retries without another browser edit", async () => {
  const f = await fixture();
  try {
    await f.poll();
    await f.acceptedMessage();
    f.onSave = async () => {
      throw Error("temporary Conat save failure");
    };
    await f.poll();
    expect((await f.runtime.api.getResource(target))?.activity).toBe(0);
    expect(f.disk().filter((row) => row.event === "chat")).toHaveLength(0);
    await f.restart();
    f.onSave = undefined;
    for (let i = 0; i < 4; i++) await f.poll();
    expect((await f.runtime.api.getResource(target))?.activity).toBe(1);
  } finally {
    await f.close();
  }
});

test.each(["disabled", "epoch"])(
  "authority becoming %s during history save prevents disk publication",
  async (change) => {
    const f = await fixture();
    try {
      await f.poll();
      await f.acceptedMessage();
      f.onSave = async () => {
        if (change === "disabled") f.enabled = false;
        else {
          const original = f.runtime.store.writerState.bind(f.runtime.store);
          jest
            .spyOn(f.runtime.store, "writerState")
            .mockImplementation(async (source) => {
              const state = await original(source);
              return state
                ? { ...state, epoch: `${state.epoch}-changed` }
                : null;
            });
        }
      };
      await expect(f.flush()).rejects.toThrow();
      expect(f.disk().filter((row) => row.event === "chat")).toHaveLength(0);
      for (const { db } of f.sessions) {
        expect(db.save_to_disk).not.toHaveBeenCalled();
        expect(db.close).toHaveBeenCalledTimes(1);
      }
    } finally {
      await f.close();
    }
  },
);

test("readiness errors close the short-lived session and retain the last metadata", async () => {
  const f = await fixture();
  try {
    await f.poll();
    await f.acceptedMessage();
    f.onAcquire = () => {
      const { db } = f.sessions[f.sessions.length - 1];
      db.isReady.mockReturnValue(false);
      queueMicrotask(() =>
        db.emit("error", Error("history connection failed")),
      );
    };
    await expect(f.flush()).rejects.toThrow("history connection failed");
    for (const { db } of f.sessions) {
      expect(db.save_to_disk).not.toHaveBeenCalled();
      expect(db.close).toHaveBeenCalledTimes(1);
    }
    expect((await f.runtime.api.getResource(target))?.activity).toBe(0);
  } finally {
    await f.close();
  }
});

test.each(["before", "after"])(
  "history capacity failure %s readiness never publishes and closes any session",
  async (phase) => {
    const f = await fixture();
    try {
      await f.poll();
      await f.acceptedMessage();
      const before = f.sessions.length;
      const admission = jest.mocked(assertCanonicalRoomHistoryBound);
      if (phase === "after") admission.mockResolvedValueOnce(undefined);
      admission.mockRejectedValueOnce(
        Error("history exceeds background flush capacity"),
      );
      await expect(f.flush()).rejects.toThrow("background flush capacity");
      expect(f.sessions).toHaveLength(before + (phase === "after" ? 1 : 0));
      for (const { db } of f.sessions) {
        expect(db.save_to_disk).not.toHaveBeenCalled();
        expect(db.close).toHaveBeenCalledTimes(1);
      }
    } finally {
      await f.close();
    }
  },
);

test("an initialized pointer to a directory is never opened as SyncDB", async () => {
  const f = await fixture();
  try {
    await f.poll();
    const opened = f.sessions.length;
    await f.fs.unlink(f.room.chat_path);
    await f.fs.mkdir(f.room.chat_path);
    await expect(f.flush()).rejects.toThrow("regular file");
    expect(f.sessions).toHaveLength(opened);
  } finally {
    await f.close();
  }
});

test("the flush excludes mediated deletion and obeys pending copy and writer fences", async () => {
  const f = await fixture();
  try {
    await f.poll();
    await f.acceptedMessage();
    const opened = f.sessions.length;
    await withCollaborationCopyLock([f.room], async () => {
      await expect(f.flush()).rejects.toThrow("busy");
    });
    expect(f.sessions).toHaveLength(opened);
    f.onSave = async () => {
      await expect(f.fs.unlink(f.room.chat_path)).rejects.toThrow("busy");
    };
    await f.flush();
    expect(existsSync(f.room.chat_path)).toBe(true);
    const original = f.runtime.store.writerState.bind(f.runtime.store);
    jest
      .spyOn(f.runtime.store, "writerState")
      .mockImplementation(async (source) => {
        const state = await original(source);
        return state ? { ...state, epoch: `${state.epoch}-changed` } : null;
      });
    const state = await original(f.room);
    await expect(
      flushLiteCanonicalRoom(
        { ...f.room, epoch: state!.epoch, generation: 0 },
        {
          project_id,
          account_id,
          client: {} as Client,
          store: f.runtime.store,
          journal: f.runtime.service.journal,
          createFilesystem: () => {
            throw Error("must reject before filesystem access");
          },
        },
      ),
    ).rejects.toThrow("authority changed");
    const afterFlush = f.sessions.length;
    f.runtime.service.journal.beginCopy(
      f.room,
      join(f.room.chat_path, "..", "other.chat"),
      false,
    );
    await expect(f.flush()).rejects.toThrow("identity transition");
    expect(f.sessions).toHaveLength(afterFlush);
  } finally {
    await f.close();
  }
});
