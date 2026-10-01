import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createChatSyncDB } from "@cocalc/chat/server";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { assertCanonicalRoomHistoryBound } from "@cocalc/backend/collaborators/flush-history";
import { flushHostedCanonicalRoom } from "./collaborators-flush";

jest.mock("@cocalc/chat/server", () => ({ createChatSyncDB: jest.fn() }));
jest.mock("@cocalc/backend/collaborators/flush-history", () => ({
  assertCanonicalRoomHistoryBound: jest.fn(),
}));
jest.mock("./artifact-catalog", () => ({ withArtifactCatalog: (fs) => fs }));
jest.mock("./sqlite/projects", () => ({
  getProject: () => ({ state: "stopped", local_only: false }),
}));
jest.mock("./sqlite/hosts", () => ({ getLocalHostId: () => "host" }));
const room = {
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  chat_path: "/home/user/.cocalc/collaborators.chat",
  initialized: true,
};
const marker = {
  event: "collaborators-room",
  project_id: room.project_id,
  room_id: room.room_id,
  mode: "human",
  schema_version: 1,
};
let journal: CollaborationJournal;
beforeEach(() => {
  jest.clearAllMocks();
  journal = new CollaborationJournal(":memory:");
});
afterEach(() => journal.close());
function setup() {
  let disk: unknown[] = [marker];
  const live: unknown[] = [marker, { event: "chat", message_id: "message" }];
  const source = { project_id: room.project_id, chat_path: room.chat_path };
  journal.touch(source);
  journal.registered(journal.registrations()[0], "epoch");
  const scan = journal.scans()[0];
  const fs: any = {
    canonicalSyncIdentityPath: jest.fn(async (path) => path),
    lstat: jest.fn(async () => ({ isFile: () => true })),
    createReadStream: jest.fn(async () =>
      Readable.from([
        Buffer.from(disk.map((r) => JSON.stringify(r)).join("\n")),
      ]),
    ),
    writeFile: jest.fn(async (_path, value) => {
      disk = value.split("\n").map(JSON.parse);
    }),
    appendFile: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn(),
    rmdir: jest.fn(),
    rename: jest.fn(),
    move: jest.fn(),
    copyFile: jest.fn(),
    cp: jest.fn(),
    close: jest.fn(),
  };
  const db = Object.assign(new EventEmitter(), {
    isReady: jest.fn(() => true),
    get: jest.fn(() => live),
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () =>
      fs.writeFile(
        source.chat_path,
        live.map((r) => JSON.stringify(r)).join("\n"),
        true,
      ),
    ),
    close: jest.fn(async () => {}),
  });
  (createChatSyncDB as jest.Mock).mockReturnValue(db);
  (assertCanonicalRoomHistoryBound as jest.Mock).mockResolvedValue(undefined);
  const writer = {
    epoch: "epoch",
    registration_id: null,
    source_sequence: 0,
    writer_host_id: "host",
    canonical_room: room,
  };
  const options = {
    journal,
    getFilesystem: jest.fn(async () => fs),
    writerState: jest.fn(async () => writer),
    client: jest.fn(() => ({}) as any),
  };
  return {
    scan,
    fs,
    db,
    options,
    writer,
    setDisk: (rows: unknown[]) => {
      disk = rows;
    },
  };
}
test("stopped-project flush uses the existing local sandbox and closes its standalone SyncDB", async () => {
  const { scan, db, fs, options } = setup();
  await flushHostedCanonicalRoom(scan, options);
  expect(createChatSyncDB).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: room.project_id,
      path: room.chat_path,
      fs,
      noBackendFsWatch: true,
    }),
  );
  expect(assertCanonicalRoomHistoryBound).toHaveBeenCalledTimes(2);
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
  expect(journal.currentScan(scan)!.generation).toBeGreaterThan(
    scan.generation,
  );
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(fs.close).toHaveBeenCalledTimes(1);
});
test("disabled mode performs no owner lookup, filesystem read or SyncDB work", async () => {
  const { scan, options } = setup();
  jest.spyOn(journal, "isEnabled").mockResolvedValue(false);
  await flushHostedCanonicalRoom(scan, options);
  expect(options.writerState).not.toHaveBeenCalled();
  expect(options.getFilesystem).not.toHaveBeenCalled();
  expect(createChatSyncDB).not.toHaveBeenCalled();
});
test.each([undefined, { ...room, initialized: false }])(
  "noncanonical/uninitialized source never opens a document (%j)",
  async (canonical_room) => {
    const { scan, options, writer } = setup();
    options.writerState.mockResolvedValue({ ...writer, canonical_room } as any);
    await flushHostedCanonicalRoom(scan, options);
    expect(options.getFilesystem).not.toHaveBeenCalled();
    expect(createChatSyncDB).not.toHaveBeenCalled();
  },
);
test.each([
  { writer_host_id: "old-host" },
  { epoch: "stale" },
  { canonical_room: { ...room, chat_path: "/home/user/other.chat" } },
])(
  "rejects wrong current authority before filesystem work (%j)",
  async (patch) => {
    const { scan, options, writer } = setup();
    options.writerState.mockResolvedValue({ ...writer, ...patch });
    await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
      /authority/,
    );
    expect(options.getFilesystem).not.toHaveBeenCalled();
  },
);
test.each(["ENOENT", "ENOTDIR"])(
  "missing room (%s) allows tombstone extraction without opening history",
  async (code) => {
    const { scan, options, fs } = setup();
    fs.lstat.mockRejectedValueOnce(Object.assign(Error("deleted"), { code }));
    await flushHostedCanonicalRoom(scan, options);
    expect(journal.currentScan(scan)).toEqual(scan);
    expect(assertCanonicalRoomHistoryBound).not.toHaveBeenCalled();
    expect(createChatSyncDB).not.toHaveBeenCalled();
    expect(fs.close).toHaveBeenCalledTimes(1);
  },
);
test("copy markers and oversized history never open live SyncDB", async () => {
  const { scan, options, setDisk } = setup();
  setDisk([marker, { event: "collaborators-identity" }]);
  await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
    /copied/,
  );
  setDisk([marker]);
  (assertCanonicalRoomHistoryBound as jest.Mock).mockRejectedValueOnce(
    Error("history capacity"),
  );
  await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
    /history capacity/,
  );
  expect(createChatSyncDB).not.toHaveBeenCalled();
});
test("pending relocation or copy prevents flush, including captured older scan work", async () => {
  const { scan, options } = setup();
  journal.beginCopy(scan, "/home/user/other.chat", false);
  await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
    /transition/,
  );
  expect(options.writerState).not.toHaveBeenCalled();
});
test("owner change during live acquisition fails before any save to disk", async () => {
  const { scan, db, options, writer } = setup();
  (createChatSyncDB as jest.Mock).mockImplementationOnce(() => {
    options.writerState.mockResolvedValue({
      ...writer,
      canonical_room: undefined,
    } as any);
    return db;
  });
  await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
    /authority/,
  );
  expect(db.save_to_disk).not.toHaveBeenCalled();
  expect(db.close).toHaveBeenCalledTimes(1);
});
test("save blocks a concurrent service delete without recursively blocking writeFile", async () => {
  const { scan, db, options, fs } = setup();
  db.save.mockImplementationOnce(async () => {
    await expect(fs.unlink(scan.chat_path)).rejects.toThrow(/busy/);
  });
  await flushHostedCanonicalRoom(scan, options);
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
});
test("failed readiness closes the document and filesystem without a disk save", async () => {
  const { scan, options, db, fs } = setup();
  db.isReady.mockReturnValue(false);
  (createChatSyncDB as jest.Mock).mockImplementationOnce(() => {
    queueMicrotask(() => db.emit("error", Error("replay unavailable")));
    return db;
  });
  await expect(flushHostedCanonicalRoom(scan, options)).rejects.toThrow(
    /replay unavailable/,
  );
  expect(db.close).toHaveBeenCalledTimes(1);
  expect(fs.close).toHaveBeenCalledTimes(1);
  expect(db.save_to_disk).not.toHaveBeenCalled();
});
