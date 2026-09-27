import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { astream } from "@cocalc/conat/sync/astream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { createChatSyncDB } from "@cocalc/chat/server";
import {
  initializeHumanRoom,
  createHumanThread,
  extractCollaborationMetadata,
} from "@cocalc/chat";
import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { assertCanonicalRoomHistoryBound } from "./flush-history";
import { flushExistingCanonicalRoom } from "./flush";
import {
  journalCollaborationFilesystem,
  readCollaborationSource,
} from "./filesystem";
import { CollaborationJournal } from "./journal";
import { withCollaborationCopyLock } from "./copy-locks";

jest.setTimeout(30_000);
beforeAll(() => before());
afterAll(after);

test("history admission works against the real server with general SQLite RPC disabled", async () => {
  const client = connect();
  const project_id = randomUUID();
  const path = "/home/user/.cocalc/collaborators.chat";
  const history = astream({
    client,
    project_id,
    name: patchesStreamName({ path }),
  });
  try {
    await history.publish({ durable: true });
    await expect(
      history.sqlite("SELECT count(*) FROM messages"),
    ).rejects.toThrow(/sqlite command not currently supported/);
    await expect(
      assertCanonicalRoomHistoryBound({ client, project_id, path }),
    ).resolves.toBeUndefined();
  } finally {
    history.close();
    client.close();
  }
});

test("standalone live SyncDB flush recovers accepted history after the author disconnects without a disk save", async () => {
  const home = await mkdtemp(join(tmpdir(), "canonical-flush-"));
  const project_id = randomUUID(),
    room_id = randomUUID(),
    account_id = randomUUID(),
    thread_id = randomUUID(),
    message_id = randomUUID();
  const source = { project_id, chat_path: join(home, "room.chat") };
  const room = { ...source, room_id, initialized: true };
  const journal = new CollaborationJournal(":memory:");
  const fs = journalCollaborationFilesystem(
    new SandboxedFilesystem(home, { rootfs: "/", unsafeMode: true }),
    project_id,
    journal,
    home,
  );
  const author = connect(),
    worker = connect();
  let authorDb: ReturnType<typeof createChatSyncDB> | undefined;
  let workerDb: ReturnType<typeof createChatSyncDB> | undefined;
  const open = async (client) => {
    const db = createChatSyncDB({
      client,
      project_id,
      path: room.chat_path,
      fs,
      noBackendFsWatch: true,
    });
    if (!db.isReady())
      await once(db, "ready", { signal: AbortSignal.timeout(10_000) });
    return db;
  };
  try {
    authorDb = await open(author);
    await initializeHumanRoom(authorDb, room);
    await createHumanThread(authorDb, { room, account_id, thread_id });
    authorDb.set({
      event: "chat",
      schema_version: 2,
      sender_id: account_id,
      message_id,
      thread_id,
      date: new Date().toISOString(),
      history: [
        { author_id: account_id, content: "Accepted before disconnect" },
      ],
    });
    authorDb.commit();
    await authorDb.save();
    const read = () => readCollaborationSource(fs, room.chat_path);
    expect(
      (await read()).some((row: any) => row.message_id === message_id),
    ).toBe(false);
    // close(), unlike end(), does not save the collaborative snapshot to disk.
    await authorDb.close();
    author.close();
    journal.registered(journal.registrations()[0], "epoch");
    const scan = journal.scans()[0];
    const result = await withCollaborationCopyLock([source], () =>
      flushExistingCanonicalRoom({
        room,
        assertCurrent: async () => journal.assertSourceReady(scan),
        read,
        acquire: async () => {
          const path = await fs.canonicalSyncIdentityPath(room.chat_path);
          await assertCanonicalRoomHistoryBound({
            client: worker,
            project_id,
            path,
          });
          workerDb = await open(worker);
          await assertCanonicalRoomHistoryBound({
            client: worker,
            project_id,
            path,
          });
          return workerDb;
        },
        release: async () => {
          await workerDb?.close();
        },
      }),
    );
    expect(result).toBe(true);
    const rows = await read();
    expect(rows.some((row: any) => row.message_id === message_id)).toBe(true);
    expect(
      extractCollaborationMetadata(rows, source, {
        humanRoomPath: room.chat_path,
      }).resources[0],
    ).toMatchObject({ participant_ids: [account_id], participant_count: 1 });
    expect(journal.currentScan(scan)!.generation).toBeGreaterThan(
      scan.generation,
    );
  } finally {
    await authorDb?.close();
    await workerDb?.close();
    author.close();
    worker.close();
    fs.close();
    journal.close();
    await rm(home, { recursive: true, force: true });
  }
});
