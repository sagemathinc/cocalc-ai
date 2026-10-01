import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { assertPendingRoomSource } from "./room-source";

let directory: string;
const room = {
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  chat_path: "",
};
const marker = {
  event: "collaborators-room",
  project_id: room.project_id,
  room_id: room.room_id,
  thread_id: room.room_id,
  sender_id: "__collaborators__",
  date: "1970-01-01T00:00:00.000Z",
  mode: "human",
  schema_version: 1,
};
const fs = {
  lstat,
  createReadStream: async (path, options) => createReadStream(path, options),
} as SandboxedFilesystem;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pending-human-room-"));
  room.chat_path = join(directory, "room.chat");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("only absence or the exact current marker allows pending initialization", async () => {
  await expect(assertPendingRoomSource(fs, room)).resolves.toBeUndefined();
  for (const rows of [
    [marker],
    [marker, { event: "chat", text: "retained" }],
  ]) {
    const bytes = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(room.chat_path, bytes);
    await expect(assertPendingRoomSource(fs, room)).resolves.toBeUndefined();
    expect(readFileSync(room.chat_path, "utf8")).toBe(bytes);
  }
});

test.each([
  ["corrupt", "{not-json"],
  ["corrupt row after marker", `${JSON.stringify(marker)}\n{not-json`],
  ["empty", ""],
  ["blank", " \n\n"],
  ["unmarked", "{}"],
  ["nonobject", `${JSON.stringify(marker)}\nnull`],
  ["array row", `${JSON.stringify(marker)}\n[]`],
  ["duplicate marker", `${JSON.stringify(marker)}\n${JSON.stringify(marker)}`],
  ["other room", JSON.stringify({ ...marker, room_id: room.project_id })],
  ["other project", JSON.stringify({ ...marker, project_id: room.room_id })],
  ["other thread", JSON.stringify({ ...marker, thread_id: room.project_id })],
  ["other mode", JSON.stringify({ ...marker, mode: "agent" })],
  ["other schema", JSON.stringify({ ...marker, schema_version: 2 })],
  ["copied", `${JSON.stringify(marker)}\n{"event":"collaborators-identity"}`],
])("rejects %s without altering disk bytes", async (_label, bytes) => {
  writeFileSync(room.chat_path, bytes);
  await expect(assertPendingRoomSource(fs, room)).rejects.toThrow();
  expect(readFileSync(room.chat_path, "utf8")).toBe(bytes);
});

test.each(["EACCES", "ENOTDIR", "EIO"])(
  "does not mistake %s for absence",
  async (code) => {
    const unavailable = {
      ...fs,
      lstat: async () => {
        throw Object.assign(Error(code), { code });
      },
    } as SandboxedFilesystem;
    await expect(assertPendingRoomSource(unavailable, room)).rejects.toThrow(
      code,
    );
  },
);

test("rejects a directory and bounds a file read before initialization", async () => {
  await expect(
    assertPendingRoomSource(fs, { ...room, chat_path: directory }),
  ).rejects.toThrow("regular file");
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, " ");
  writeFileSync(room.chat_path, bytes);
  await expect(assertPendingRoomSource(fs, room)).rejects.toThrow("read limit");
  expect(readFileSync(room.chat_path).equals(bytes)).toBe(true);
});
