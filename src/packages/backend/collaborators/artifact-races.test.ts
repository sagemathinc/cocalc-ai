import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactCatalogService } from "../artifacts/service";
import { journalArtifactFilesystem } from "../artifacts/filesystem";
import { CollaborationJournal } from "./journal";
import { journalCollaborationFilesystem } from "./filesystem";

const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/a.chat",
};
const destination = { ...source, chat_path: "/home/user/b.chat" };

test("stacked filesystem journals fence artifact relocation and old writers reread after owner CAS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "collaboration-artifact-race-"));
  const now = jest.spyOn(Date, "now").mockReturnValue(0);
  const collaboration = new CollaborationJournal(":memory:");
  let title = "before recovery";
  const states = new Map(
    [source, destination].map((s) => [
      s.chat_path,
      {
        epoch: `old:${s.chat_path}`,
        writer_host_id: "host" as string | null,
        registration_id: "original",
      },
    ]),
  );
  const accepted: any[] = [];
  const remoteSend = jest.fn(async (snapshot) => {
    if (snapshot.epoch !== states.get(snapshot.chat_path)!.epoch)
      throw Error("stale artifact writer");
    accepted.push(snapshot);
  });
  const read = jest.fn(async (s) => {
    collaboration.assertSourceReady(s);
    return [
      {
        thread_id: "thread",
        artifact_id: "artifact",
        kind: "file",
        title,
        description: "",
        created_at: 1,
        publication: { operation_id: "publish", message_id: "message" },
      },
    ];
  });
  const register = jest.fn(async (s) => {
    collaboration.assertSourceReady(s);
    const state = states.get(s.chat_path)!;
    if (s.expected_epoch !== state.epoch) throw Error("stale registration");
    state.epoch = "fresh-artifact-writer";
    state.writer_host_id = "host";
    state.registration_id = s.registration_id;
    return { epoch: state.epoch };
  });
  const artifacts = new ArtifactCatalogService({
    filename: join(directory, "artifact.sqlite"),
    read,
    register,
    writerState: async (s) => {
      collaboration.assertSourceReady(s);
      return states.get(s.chat_path)!;
    },
    recoverWriter: async (s, expected) => {
      collaboration.assertSourceReady(s);
      const state = states.get(s.chat_path)!;
      return state.epoch !== expected && state.writer_host_id !== "host"
        ? { epoch: state.epoch }
        : undefined;
    },
    send: async (snapshot) => {
      collaboration.assertSourceReady(snapshot);
      await remoteSend(snapshot);
    },
    discover: async () => [],
    onError: jest.fn(),
  });
  const run = () => (artifacts as any).runOnce() as Promise<void>;
  try {
    for (const s of [source, destination])
      artifacts.journal.register(s, states.get(s.chat_path)!.epoch);
    collaboration.touch(source);
    collaboration.registered(
      collaboration.registrations()[0],
      "collaboration-epoch",
    );
    const fs: any = { canonicalSyncIdentityPath: async (path) => path };
    for (const name of [
      "writeFile",
      "appendFile",
      "unlink",
      "rm",
      "rmdir",
      "rename",
      "move",
      "copyFile",
      "cp",
    ])
      fs[name] = jest.fn(async () => {});
    fs.rename.mockImplementation(async () => {
      expect(artifacts.journal.scans()).toEqual([]);
      expect(() => collaboration.assertSourceReady(source)).toThrow(
        /transition/,
      );
      expect(() => collaboration.assertSourceReady(destination)).toThrow(
        /transition/,
      );
      await run();
    });
    journalCollaborationFilesystem(
      journalArtifactFilesystem(fs, source.project_id, artifacts.journal),
      source.project_id,
      collaboration,
    );
    await fs.rename(source.chat_path, destination.chat_path);
    await run();
    expect(remoteSend).not.toHaveBeenCalled();
    // The owning bay rotates both artifact epochs and clears writer authority.
    for (const state of states.values()) {
      state.epoch = `fenced:${state.epoch}`;
      state.writer_host_id = null;
    }
    collaboration.acknowledgeRelocation(
      collaboration.relocations()[0].operation_id,
      "moved-collaboration-epoch",
    );
    expect(() => collaboration.assertSourceReady(source)).toThrow(/retired/);
    expect(() => collaboration.assertSourceReady(destination)).not.toThrow();
    now.mockReturnValue(2000);
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(artifacts.journal.deliveries(16, 10000)).toEqual([]);
    title = "fresh content after fencing";
    now.mockReturnValue(6000);
    await run();
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        ...destination,
        expected_epoch: `fenced:old:${destination.chat_path}`,
      }),
    );
    expect(accepted).toEqual([
      expect.objectContaining({
        ...destination,
        epoch: "fresh-artifact-writer",
        items: [expect.objectContaining({ title })],
      }),
    ]);
    expect(
      remoteSend.mock.calls.every(
        ([snapshot]) => snapshot.chat_path === destination.chat_path,
      ),
    ).toBe(true);
  } finally {
    await artifacts.close();
    collaboration.close();
    now.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact guard keeps ambiguous copies fenced and releases only a confirmed namespace", () => {
  const journal = new CollaborationJournal(":memory:");
  try {
    const operation = journal.beginCopy(destination, source.chat_path, true);
    expect(() => journal.assertSourceReady(source)).not.toThrow();
    expect(() => journal.assertSourceReady(destination)).toThrow(/transition/);
    journal.finishCopy(operation, "fingerprint");
    expect(() => journal.assertSourceReady(destination)).toThrow(/transition/);
    journal.acknowledgeCopy(operation);
    expect(() => journal.assertSourceReady(destination)).not.toThrow();
    journal.beginCopy(destination, source.chat_path, false);
    expect(() => journal.assertSourceReady(destination)).toThrow(/transition/);
  } finally {
    journal.close();
  }
});
