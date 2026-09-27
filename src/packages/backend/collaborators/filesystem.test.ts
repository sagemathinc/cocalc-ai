import { CollaborationJournal } from "./journal";
import {
  collaborationCopySourceFingerprint,
  journalCollaborationFilesystem,
  readCollaborationSource,
} from "./filesystem";
import { Readable } from "node:stream";
import { ArtifactCatalogJournal } from "@cocalc/backend/artifacts/journal";
import { journalArtifactFilesystem } from "@cocalc/backend/artifacts/filesystem";
import { withCollaborationCopyLock } from "./copy-locks";
const project_id = "11111111-1111-4111-8111-111111111111";
let journal: CollaborationJournal;
beforeEach(() => {
  journal = new CollaborationJournal(":memory:");
});
afterEach(() => {
  journal.close();
});
function fixture() {
  const fs: any = {
    canonicalSyncIdentityPath: async (path) => path,
    writeFile: jest.fn(async () => {}),
    appendFile: jest.fn(async () => {}),
    unlink: jest.fn(async () => {}),
    rm: jest.fn(async () => {}),
    rmdir: jest.fn(async () => {}),
    rename: jest.fn(async () => {}),
    move: jest.fn(async () => {}),
    copyFile: jest.fn(async () => {}),
    cp: jest.fn(async () => {}),
  };
  return fs;
}

test("write intent exists before a filesystem mutation and dirty work survives failure", async () => {
  const fs = fixture();
  const source = { project_id, chat_path: "/home/user/a.chat" };
  journal.touch(source);
  journal.registered(journal.registrations()[0], "epoch");
  fs.writeFile.mockImplementationOnce(async () => {
    expect(journal.scans()).toEqual([]);
    throw Error("disk full");
  });
  journalCollaborationFilesystem(fs, project_id, journal);
  await expect(fs.writeFile(source.chat_path, "irrelevant")).rejects.toThrow(
    "disk full",
  );
  expect(journal.scans()).toHaveLength(1);
});
test.each(["writeFile", "writeFileDelta"])(
  "%s atomic rename shares one intent while retaining artifact observers",
  async (method) => {
    const fs = fixture();
    const source = { project_id, chat_path: "/home/user/a.chat" };
    const artifacts = new ArtifactCatalogJournal(":memory:");
    journal.touch(source);
    journal.registered(journal.registrations()[0], "epoch");
    const begin = jest.spyOn(journal, "beginWrite");
    const artifactBegin = jest.spyOn(artifacts, "beginWrite");
    const artifactFinish = jest.spyOn(artifacts, "finishWrite");
    const rename = fs.rename;
    fs.writeFile.mockImplementation(async (path) => {
      expect(journal.scans()).toEqual([]);
      await fs.rename(`${path}.tmp`, path);
      expect(journal.scans()).toEqual([]);
    });
    fs.writeFileDelta = async (...args) => fs.writeFile(...args);
    try {
      journalArtifactFilesystem(fs, project_id, artifacts);
      journalCollaborationFilesystem(fs, project_id, journal);
      await withCollaborationCopyLock([source], async () => {
        await fs[method](source.chat_path, "content");
        await expect(fs.unlink(source.chat_path)).rejects.toThrow(/busy/);
      });
      expect(rename).toHaveBeenCalledWith(
        `${source.chat_path}.tmp`,
        source.chat_path,
      );
      expect(begin).toHaveBeenCalledTimes(1);
      expect(artifactBegin).toHaveBeenCalled();
      expect(artifactFinish).toHaveBeenCalledTimes(
        artifactBegin.mock.calls.length,
      );
      expect(journal.relocations()).toEqual([]);
      expect(journal.scans()).toHaveLength(1);
    } finally {
      artifacts.close();
    }
  },
);
test("directory rename persists bounded relocation intents before touching filesystem", async () => {
  const fs = fixture();
  journal.touch({ project_id, chat_path: "/home/user/old/a.chat" });
  fs.rename.mockImplementationOnce(async () => {
    expect(journal.relocations()[0]).toMatchObject({
      from_path: "/home/user/old/a.chat",
      to_path: "/home/user/new/a.chat",
      state: "pending",
    });
  });
  journalCollaborationFilesystem(fs, project_id, journal);
  await fs.rename("/home/user/old", "/home/user/new");
  expect(journal.relocations()[0].state).toBe("ready");
});
test("copies of not-yet-indexed chats are quarantined without editing chat bytes", async () => {
  const fs = fixture();
  const copy = fs.copyFile;
  journalCollaborationFilesystem(fs, project_id, journal);
  await fs.copyFile("/home/user/original.chat", "/home/user/copy.chat");
  expect(copy).toHaveBeenCalledWith(
    "/home/user/original.chat",
    "/home/user/copy.chat",
  );
  for (const source of journal.registrations())
    journal.registered(source, "epoch");
  expect(journal.scans()).toEqual([]);
});
function copyFixture() {
  const fs = fixture();
  const files = new Map<string, string>([
    [
      "/home/user/original.chat",
      '{"event":"chat-thread-config","thread_id":"human","agent_kind":"none"}\n',
    ],
  ]);
  fs.lstat = jest.fn(async (path) => {
    if (!files.has(path))
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    return { isDirectory: () => false, isFile: () => true };
  });
  fs.createReadStream = jest.fn(async (path) =>
    Readable.from([Buffer.from(files.get(path)!)]),
  );
  fs.copyFile.mockImplementation(async (from, to) => {
    expect(journal.copies()[0].state).toBe("pending");
    files.set(to, files.get(from)!);
  });
  return { fs, files };
}
test("successful fresh copies persist operation and content witness before live namespace initialization", async () => {
  const { fs, files } = copyFixture();
  const writeFile = fs.writeFile;
  journalCollaborationFilesystem(fs, project_id, journal);
  await fs.copyFile("/home/user/original.chat", "/home/user/copy.chat");
  expect(journal.copies()[0]).toMatchObject({
    state: "ready",
    fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(files.get("/home/user/copy.chat")).toBe(
    files.get("/home/user/original.chat"),
  );
  expect(writeFile).not.toHaveBeenCalled();
  const operation = journal.copies()[0].operation_id;
  journal.acknowledgeCopy(operation);
  expect(journal.copies()).toEqual([]);
});
test("failed copies and known overwrites stay quarantined, never sent for marker mutation", async () => {
  const { fs, files } = copyFixture();
  const copyFile = fs.copyFile;
  fs.copyFile.mockRejectedValueOnce(Error("copy failed"));
  journalCollaborationFilesystem(fs, project_id, journal);
  await expect(
    fs.copyFile("/home/user/original.chat", "/home/user/failed.chat"),
  ).rejects.toThrow(/failed/);
  files.set("/home/user/existing.chat", "old content");
  copyFile.mockImplementationOnce(async () => {});
  await fs.copyFile("/home/user/original.chat", "/home/user/existing.chat");
  expect(journal.copies().every((c) => c.state === "unknown")).toBe(true);
  expect(journal.copies(100, Date.now())).toEqual([]);
});
test("a concurrent replacement fails the copy witness and remains quarantined", async () => {
  const { fs, files } = copyFixture();
  fs.copyFile.mockImplementationOnce(async (_from, to) =>
    files.set(to, '{"event":"changed"}\n'),
  );
  journalCollaborationFilesystem(fs, project_id, journal);
  await expect(
    fs.copyFile("/home/user/original.chat", "/home/user/copy.chat"),
  ).rejects.toThrow(/changed/);
  expect(journal.copies()[0].state).toBe("unknown");
});
test("directory copies discover previously unindexed chats and nested copyFile calls share the outer intents", async () => {
  const fs = fixture();
  const contents =
    '{"event":"chat-thread-config","thread_id":"human","agent_kind":"none"}\n';
  const files = new Map([
    ["/home/user/tree/a.chat", contents],
    ["/home/user/tree/nested/b.chat", contents],
  ]);
  const directories = new Set(["/home/user/tree", "/home/user/tree/nested"]);
  fs.lstat = jest.fn(async (path) => {
    if (!files.has(path) && !directories.has(path))
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    return {
      isFile: () => files.has(path),
      isDirectory: () => directories.has(path),
    };
  });
  fs.readdir = jest.fn(async (path) =>
    path === "/home/user/tree" ? ["a.chat", "nested"] : ["b.chat"],
  );
  fs.createReadStream = jest.fn(async (path) =>
    Readable.from([Buffer.from(files.get(path)!)]),
  );
  fs.copyFile.mockImplementation(async (from, to) => {
    files.set(to, files.get(from)!);
  });
  fs.cp.mockImplementation(async () => {
    expect(journal.copies()).toHaveLength(2);
    await fs.copyFile("/home/user/tree/a.chat", "/home/user/clone/a.chat");
    await fs.copyFile(
      "/home/user/tree/nested/b.chat",
      "/home/user/clone/nested/b.chat",
    );
  });
  journalCollaborationFilesystem(fs, project_id, journal);
  await fs.cp("/home/user/tree", "/home/user/clone", { recursive: true });
  expect(journal.copies()).toHaveLength(2);
  expect(journal.copies().every((copy) => copy.state === "ready")).toBe(true);
  expect(new Set(journal.copies().map((copy) => copy.operation_id)).size).toBe(
    2,
  );
});
test("copy witness ignores row and property serialization order but not authored edits", () => {
  const first = [
    { event: "chat", thread_id: "thread", history: [{ content: "authored" }] },
    { event: "chat-thread", thread_id: "thread" },
  ];
  const reordered = [
    { thread_id: "thread", event: "chat-thread" },
    { history: [{ content: "authored" }], thread_id: "thread", event: "chat" },
  ];
  expect(collaborationCopySourceFingerprint(first)).toBe(
    collaborationCopySourceFingerprint(reordered),
  );
  expect(collaborationCopySourceFingerprint(first)).not.toBe(
    collaborationCopySourceFingerprint([
      { ...first[0], history: [{ content: "edited" }] },
    ]),
  );
});
test("large non-chat directory copies do not stat every data file or consume chat discovery capacity", async () => {
  const fs = fixture();
  const original = fs.cp;
  fs.lstat = jest.fn(async () => ({ isDirectory: () => true }));
  fs.readdir = jest.fn(async () =>
    Array.from({ length: 20_000 }, (_, i) => ({
      name: `data-${i}.bin`,
      isDirectory: () => false,
    })),
  );
  fs.createReadStream = jest.fn();
  const beginCopy = jest.spyOn(journal, "beginCopy");
  journalCollaborationFilesystem(fs, project_id, journal);
  await fs.cp("/home/user/data", "/home/user/clone", { recursive: true });
  expect(original).toHaveBeenCalledTimes(1);
  expect(fs.lstat).toHaveBeenCalledTimes(1);
  expect(fs.readdir).toHaveBeenCalledWith("/home/user/data", {
    withFileTypes: true,
  });
  expect(fs.createReadStream).not.toHaveBeenCalled();
  expect(beginCopy).not.toHaveBeenCalled();
});
test("legacy sage-chat writes are journaled and wrapper installation is idempotent", async () => {
  const fs = fixture();
  journalCollaborationFilesystem(fs, project_id, journal);
  const wrapped = fs.writeFile;
  journalCollaborationFilesystem(fs, project_id, journal);
  expect(fs.writeFile).toBe(wrapped);
  await fs.writeFile("/home/user/a.sage-chat", "");
  expect(journal.sources()[0].chat_path).toBe("/home/user/a.sage-chat");
});
test("standalone Lite may supply a canonical home outside the hosted project path", async () => {
  const fs = fixture();
  journalCollaborationFilesystem(
    fs,
    project_id,
    journal,
    "/Users/alice/workspace",
  );
  await fs.writeFile("relative.chat", "");
  expect(journal.sources()[0].chat_path).toBe(
    "/Users/alice/workspace/relative.chat",
  );
});
test("bounded source reads distinguish missing files from corrupt, oversized and denied sources", async () => {
  const fs: any = {
    createReadStream: jest.fn(async () =>
      Readable.from([Buffer.from('{"event":"chat"}\n')]),
    ),
  };
  expect(await readCollaborationSource(fs, "a.chat")).toEqual([
    { event: "chat" },
  ]);
  fs.createReadStream.mockRejectedValueOnce(
    Object.assign(Error("missing"), { code: "ENOENT" }),
  );
  expect(await readCollaborationSource(fs, "a.chat")).toEqual([]);
  fs.createReadStream.mockRejectedValueOnce(
    Object.assign(Error("denied"), { code: "EACCES" }),
  );
  await expect(readCollaborationSource(fs, "a.chat")).rejects.toThrow(/denied/);
  fs.createReadStream.mockResolvedValueOnce(
    Readable.from([Buffer.from("bad json")]),
  );
  await expect(readCollaborationSource(fs, "a.chat")).rejects.toThrow();
  await expect(readCollaborationSource(fs, "a.chat", 2)).rejects.toThrow(
    /limit/,
  );
});
