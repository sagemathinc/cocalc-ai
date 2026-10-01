import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { CollaborationJournal } from "@cocalc/backend/collaborators/journal";
import { ArtifactCatalogJournal } from "@cocalc/backend/artifacts/journal";
import { journalArtifactFilesystem } from "@cocalc/backend/artifacts/filesystem";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { getCollaboratorsService } from "./collaborators";
import { withArtifactCatalog } from "./artifact-catalog";
import { journalSameProjectBulkCopy } from "./collaborators-bulk-copy";
import { replacePathFromStaging } from "./path-copy-archive";

jest.mock("./collaborators", () => ({ getCollaboratorsService: jest.fn() }));
jest.mock("./artifact-catalog", () => ({ withArtifactCatalog: jest.fn() }));
const project_id = "11111111-1111-4111-8111-111111111111";
const content =
  '{"event":"chat-thread-config","thread_id":"thread","agent_kind":"none"}\n';
let directory: string,
  journal: CollaborationJournal,
  artifacts: ArtifactCatalogJournal,
  enabled: jest.Mock,
  fs: any;
const local = (path: string) =>
  join(directory, path.replace(/^\/home\/user\/?/, ""));
beforeEach(async () => {
  jest.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "collaboration-bulk-copy-"));
  enabled = jest.fn(async () => true);
  journal = new CollaborationJournal(":memory:", undefined, false, enabled);
  artifacts = new ArtifactCatalogJournal(":memory:");
  (getCollaboratorsService as jest.Mock).mockReturnValue({ journal });
  (withArtifactCatalog as jest.Mock).mockImplementation((fs, project) =>
    journalArtifactFilesystem(fs, project, artifacts),
  );
  fs = {
    canonicalSyncIdentityPath: jest.fn(async (path) =>
      posix.resolve("/home/user", path),
    ),
    lstat: jest.fn(async (path) => lstat(local(path))),
    stat: jest.fn(async (path) => stat(local(path))),
    readdir: jest.fn(async (path, opts) => readdir(local(path), opts)),
    createReadStream: jest.fn(async (path, opts) =>
      createReadStream(local(path), opts),
    ),
  };
  for (const method of [
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
    fs[method] = jest.fn();
  await writeFile(local("original.chat"), content);
});
afterEach(async () => {
  journal.close();
  artifacts.close();
  await rm(directory, { recursive: true, force: true });
});

test.each([false, true])(
  "bulk copy journals the final chat path before raw I/O, including exact staged copy=%s",
  async (exact) => {
    const originalCp = fs.cp;
    const copy = jest.fn(async () => {
      expect(journal.copies()).toEqual([
        expect.objectContaining({
          chat_path: "/home/user/copied.chat",
          state: "pending",
        }),
      ]);
      expect(artifacts.sources(project_id)).toEqual([
        { project_id, chat_path: "/home/user/copied.chat" },
      ]);
      if (exact)
        await replacePathFromStaging({
          source: local("original.chat"),
          destination: local("copied.chat"),
          destinationExists: false,
          copy: (from, to) => cp(from, to),
        });
      else await cp(local("original.chat"), local("copied.chat"));
    });
    await journalSameProjectBulkCopy({
      fs,
      project_id,
      source: "original.chat",
      destination: "copied.chat",
      options: { reflink: true },
      copy,
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(fs.cp).toBe(originalCp);
    expect(journal.copies()).toEqual([
      expect.objectContaining({
        state: "ready",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(await readFile(local("copied.chat"), "utf8")).toBe(content);
    expect(
      journal.sources().some((s) => s.chat_path.includes("cocalc-incoming")),
    ).toBe(false);
    expect(journal.scans()).toEqual([]);
  },
);
test("bulk directory and array copies discover new chats and allocate separate durable intents", async () => {
  await mkdir(local("tree"));
  await writeFile(local("tree/nested.chat"), content);
  await mkdir(local("copies"));
  const copy = async () => {
    expect(journal.copies()).toHaveLength(2);
    await cp(local("original.chat"), local("copies/original.chat"));
    await cp(local("tree"), local("copies/tree"), { recursive: true });
  };
  await journalSameProjectBulkCopy({
    fs,
    project_id,
    source: ["original.chat", "tree"],
    destination: "copies",
    options: { recursive: true, reflink: true },
    copy,
  });
  expect(journal.copies().every((c) => c.state === "ready")).toBe(true);
  expect(new Set(journal.copies().map((c) => c.operation_id)).size).toBe(2);
});
test("known overwrites and failed partial bulk copies never authorize namespace mutation", async () => {
  await writeFile(local("copied.chat"), "existing bytes");
  await journalSameProjectBulkCopy({
    fs,
    project_id,
    source: "original.chat",
    destination: "copied.chat",
    options: { reflink: true },
    copy: () => cp(local("original.chat"), local("copied.chat")),
  });
  expect(journal.copies()[0].state).toBe("unknown");
  await expect(
    journalSameProjectBulkCopy({
      fs,
      project_id,
      source: "original.chat",
      destination: "failed.chat",
      copy: async () => {
        await writeFile(local("failed.chat"), content);
        throw Error("partial failure");
      },
    }),
  ).rejects.toThrow(/partial failure/);
  expect(journal.copies().every((c) => c.state === "unknown")).toBe(true);
});
test("no-clobber copy preserves an existing indexed source rather than quarantining a skipped write", async () => {
  await writeFile(local("copied.chat"), content);
  const source = { project_id, chat_path: "/home/user/copied.chat" };
  journal.touch(source);
  journal.registered(journal.registrations()[0], "epoch");
  await journalSameProjectBulkCopy({
    fs,
    project_id,
    source: "original.chat",
    destination: "copied.chat",
    options: { force: false, reflink: true },
    copy: () =>
      cp(local("original.chat"), local("copied.chat"), { force: false }),
  });
  expect(journal.copies()).toEqual([]);
  expect(journal.scans()).toHaveLength(1);
});
test("exact tree replacement cannot remove a known chat while its namespace initializer holds the path", async () => {
  const retained = { project_id, chat_path: "/home/user/tree/retained.chat" };
  journal.touch(retained);
  const copy = jest.fn(async () => {});
  await withCollaborationCopyLock([retained], async () => {
    await expect(
      journalSameProjectBulkCopy({
        fs,
        project_id,
        source: "original.chat",
        destination: "tree",
        copy,
      }),
    ).rejects.toThrow(/busy/);
  });
  expect(copy).not.toHaveBeenCalled();
});
test.each(["disabled", "unavailable", "not-started"])(
  "bulk copy is untouched when collaboration is %s",
  async (state) => {
    if (state === "disabled") enabled.mockResolvedValue(false);
    if (state === "unavailable")
      enabled.mockRejectedValue(Error("flag unavailable"));
    if (state === "not-started")
      (getCollaboratorsService as jest.Mock).mockImplementationOnce(() => {
        throw Error("not started");
      });
    const copy = jest.fn(async () => {}),
      begin = jest.spyOn(journal, "beginCopy");
    await journalSameProjectBulkCopy({
      fs,
      project_id,
      source: "large-tree",
      destination: "copy",
      copy,
    });
    expect(copy).toHaveBeenCalledTimes(1);
    for (const call of [
      withArtifactCatalog,
      fs.canonicalSyncIdentityPath,
      fs.lstat,
      fs.readdir,
      fs.createReadStream,
      begin,
    ])
      expect(call).not.toHaveBeenCalled();
  },
);
