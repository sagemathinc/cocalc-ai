/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import {
  buildChatMessage,
  createHumanThread,
  initializeHumanRoom,
  sendHumanMessage,
} from "@cocalc/chat";
import type { HumanRoomSyncDB } from "@cocalc/chat";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import { createLiteCollaborators } from "./service";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const thread_id = "33333333-3333-4333-8333-333333333333";
const message_id = "44444444-4444-4444-8444-444444444444";
const primaryKeys = ["date", "sender_id", "event", "message_id", "thread_id"];

test("serialized human chat disk flush drives participants, For You, revisions and restart-safe updates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-serialized-chat-"));
  const options = {
    directory: join(directory, "private"),
    path: directory,
    project_id,
    account_id,
    isEnabled: () => true,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  };
  let runtime = createLiteCollaborators(options);
  const filesystem = new SandboxedFilesystem(directory, {
    unsafeMode: true,
    rootfs: "/",
  });
  let fs = runtime.wrapFilesystem(filesystem, project_id);
  try {
    const room = await runtime.api.ensureRoom({
      account_id,
      project_id,
      request_id: "room",
    });
    await runtime.ensureRoomDirectory(room);
    let doc = from_str("", primaryKeys, ["input"]);
    let durableHistory = "";
    let valueOnDisk = "";
    // Only the transport is substituted: records, serialization, atomic delta
    // writes, filesystem journaling, extraction and SQLite ingestion are real.
    const db: HumanRoomSyncDB = {
      get: () => doc.get(),
      set: (row) => {
        doc = doc.set(row);
      },
      commit() {},
      save: async () => {
        durableHistory = doc.to_str();
      },
      save_to_disk: async () => {
        await db.save();
        const value = doc.to_str();
        await fs.writeFileDelta(room.chat_path, value, {
          baseContents: valueOnDisk,
          saveLast: true,
        });
        valueOnDisk = value;
      },
    };
    await initializeHumanRoom(db, room);
    runtime.service.journal.armNotifications(
      { project_id, chat_path: room.chat_path },
      room.room_id,
    );
    await createHumanThread(db, {
      room,
      account_id,
      thread_id,
      title: "Real serialized human discussion",
    });
    await runtime.service.runOnce();
    const target = {
      account_id,
      project_id,
      kind: "conversation" as const,
      resource_id: thread_id,
    };
    const initial = await runtime.api.listResources({ account_id });
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({
      resource_id: thread_id,
      participant_ids: [],
      participant_count: 0,
      activity: 0,
    });
    expect(from_str(valueOnDisk, primaryKeys).get()).toHaveLength(3);

    const body = "Private browser message, not metadata. ".repeat(40);
    const before = doc;
    db.set(
      buildChatMessage({
        prevHistory: [],
        sender_id: account_id,
        thread_id,
        message_id,
        date: new Date(),
        content: body,
        generating: false,
        schema_version: 2,
      }),
    );
    expect(doc.changes(before).size).toBe(1);
    await db.save();
    // Reproduce the browser incident: durable chat history alone does not make
    // a disk-backed metadata reader see the message, even after another scan.
    doc = from_str(durableHistory, primaryKeys, ["input"]);
    expect(doc.get({ event: "chat" })).toHaveLength(1);
    runtime.service.journal.touch({ project_id, chat_path: room.chat_path });
    await runtime.service.runOnce();
    expect(readFileSync(room.chat_path, "utf8")).toBe(valueOnDisk);
    expect((await runtime.api.getResource(target))?.participant_ids).toEqual(
      [],
    );
    expect(
      (await runtime.api.listResources({ account_id, scope: "for-you" })).items,
    ).toEqual([]);

    // The same writeFileDelta path used by SyncDoc must journal a new scan.
    await db.save_to_disk();
    const serialized = readFileSync(room.chat_path, "utf8");
    expect(serialized).toBe(doc.to_str());
    expect(from_str(serialized, primaryKeys).get({ event: "chat" })).toEqual([
      expect.objectContaining({
        message_id,
        sender_id: account_id,
        history: [expect.objectContaining({ content: body })],
      }),
    ]);
    await runtime.service.runOnce();
    const indexed = await runtime.api.getResource(target);
    expect(indexed).toMatchObject({
      resource_id: thread_id,
      participant_ids: [account_id],
      participant_count: 1,
      activity: 1,
      personal: { read_through: 0, following: false, muted: false },
    });
    expect(JSON.stringify(indexed)).not.toContain("Private browser message");
    expect(
      (await runtime.api.listResources({ account_id, scope: "for-you" })).items,
    ).toEqual([
      expect.objectContaining({
        resource_id: thread_id,
        reason: "participation",
      }),
    ]);
    expect(
      await runtime.api.check({ account_id, since: initial.revision }),
    ).toMatchObject({ reset: true });

    await runtime.api.setPersonalState({
      ...target,
      patch: { read_through: 1, following: false, muted: true },
    });
    fs.close();
    await runtime.close();
    runtime = createLiteCollaborators(options);
    fs = runtime.wrapFilesystem(
      new SandboxedFilesystem(directory, { unsafeMode: true, rootfs: "/" }),
      project_id,
    );
    doc = from_str(serialized, primaryKeys, ["input"]);
    await sendHumanMessage(db, {
      room,
      account_id,
      thread_id,
      message_id: "55555555-5555-4555-8555-555555555555",
      text: "A later message after reopening the room",
    });
    await runtime.service.runOnce();
    expect(await runtime.api.getResource(target)).toMatchObject({
      participant_ids: [account_id],
      participant_count: 1,
      activity: 2,
      personal: { read_through: 1, following: false, muted: true },
    });
    runtime.service.journal.touch({ project_id, chat_path: room.chat_path });
    await runtime.service.runOnce();
    expect(await runtime.api.getResource(target)).toMatchObject({
      activity: 2,
      personal: { read_through: 1, following: false, muted: true },
    });
  } finally {
    fs.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
