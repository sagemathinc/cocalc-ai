/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import type { Client } from "@cocalc/conat/core/client";
import { createLiteCollaborators } from "./service";
import { initLiteCollaboratorsRoomService } from "./room-service";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));

test("explicit room creation prepares its parent before atomic save, but never recreates an initialized deleted room", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-room-directory-"));
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";
  const request_id = "33333333-3333-4333-8333-333333333333";
  const subject = `services.account-${account_id}._.${project_id}._.collaborators`;
  let enabled = true;
  const runtime = createLiteCollaborators({
    directory: join(directory, "private"),
    path: directory,
    account_id,
    project_id,
    isEnabled: () => enabled,
    sourcePage: async () => ({ paths: [] }),
    agentPins: { read: () => [], set: () => {} },
  });
  const rows: any[] = [];
  let handlers: any;
  const service = await initLiteCollaboratorsRoomService(
    {
      service: async (_subject, methods) => {
        handlers = methods;
        return { close() {} };
      },
    } as unknown as Client,
    runtime,
  );
  try {
    const room = await runtime.api.ensureRoom({
      account_id,
      project_id,
      request_id,
    });
    const parent = dirname(room.chat_path);
    expect(existsSync(parent)).toBe(false);
    await runtime.api.listResources({ account_id });
    await runtime.service.runOnce();
    expect(existsSync(parent)).toBe(false);
    jest.mocked(acquireChatSyncDB).mockImplementation(async () => {
      expect(existsSync(parent)).toBe(true);
      return {
        get: () => rows,
        set: (row) => rows.push(row),
        commit() {},
        save: async () => {},
        save_to_disk: async () => {
          const temporary = join(parent, ".collaborators.chat.tmp.test");
          writeFileSync(
            temporary,
            rows.map((row) => JSON.stringify(row)).join("\n"),
          );
          renameSync(temporary, room.chat_path);
        },
      } as any;
    });
    jest.mocked(releaseChatSyncDB).mockResolvedValue(undefined);
    enabled = false;
    await expect(
      handlers.createThread.call(
        { subject },
        { request_id, expected_room_id: room.room_id },
      ),
    ).rejects.toThrow("disabled");
    expect(existsSync(parent)).toBe(false);
    enabled = true;
    await expect(
      runtime.ensureRoomDirectory({
        ...room,
        chat_path: join(directory, "foreign", "room.chat"),
      }),
    ).rejects.toThrow("registration changed");
    expect(existsSync(join(directory, "foreign"))).toBe(false);
    await handlers.createThread.call(
      { subject },
      { request_id, expected_room_id: room.room_id, title: "First discussion" },
    );
    expect(existsSync(room.chat_path)).toBe(true);
    expect(rows.filter((row) => row.event === "chat-thread")).toHaveLength(1);
    rmSync(parent, { recursive: true });
    jest.mocked(acquireChatSyncDB).mockClear();
    await expect(
      handlers.createThread.call(
        { subject },
        { request_id, expected_room_id: room.room_id },
      ),
    ).rejects.toThrow();
    await expect(runtime.ensureRoomDirectory(room)).rejects.toThrow(
      "explicit restore",
    );
    expect(acquireChatSyncDB).not.toHaveBeenCalled();
    expect(existsSync(parent)).toBe(false);
  } finally {
    await service.close();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
    jest.resetAllMocks();
  }
});
