import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { journalArtifactFilesystem, readArtifactSource } from "./filesystem";
import { ArtifactCatalogJournal } from "./journal";
import { ArtifactCatalogProjector } from "./projector";

const project_id = "11111111-1111-4111-8111-111111111111";
const source = (path: string) => ({
  project_id,
  chat_path: `/home/user/${path}`,
});
let dir: string;
let fs: SandboxedFilesystem;
let journal: ArtifactCatalogJournal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "artifact-filesystem-"));
  await mkdir(join(dir, "home"));
  fs = new SandboxedFilesystem(join(dir, "home"), {
    homeAliases: ["/home/user"],
  });
  journal = new ArtifactCatalogJournal(join(dir, "journal.sqlite"));
});

afterEach(async () => {
  jest.restoreAllMocks();
  journal.close();
  await rm(dir, { recursive: true, force: true });
});

function clean(path: string) {
  journal.register(source(path), "epoch");
  const scan = journal
    .scans(100)
    .find((s) => s.chat_path === source(path).chat_path)!;
  expect(journal.prepare(scan, [])).toBe(true);
  journal.acknowledge(
    journal.deliveries(100).find((s) => s.chat_path === scan.chat_path)!,
  );
}

test("intent is durable before mutation and remains active until it settles", async () => {
  const s = source("a.chat");
  journal.register(s, "epoch");
  const staleScan = journal.scans()[0];
  journal.prepare(staleScan, []);
  const original = fs.writeFile.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fs.writeFile = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  journalArtifactFilesystem(fs, project_id, journal);
  const pending = fs.writeFile("a.chat", '{"saved":true}\n');
  await inside;
  try {
    const observer = new ArtifactCatalogJournal(join(dir, "journal.sqlite"));
    try {
      expect(observer.sources(project_id)).toEqual([s]);
      expect(observer.scans()).toEqual([]);
      expect(observer.deliveries()).toEqual([]);
      expect(observer.prepare(staleScan, [])).toBe(false);
      expect(await fs.exists("a.chat")).toBe(false);
    } finally {
      observer.close();
    }
  } finally {
    release();
    await pending;
  }
  expect(journal.scans()).toHaveLength(1);
  expect(await readArtifactSource(fs, "a.chat")).toEqual([{ saved: true }]);
});

test("failed writes preserve the original error and reconcile actual partial bytes", async () => {
  clean("a.chat");
  const failure = Error("write failed after changing bytes");
  const original = fs.writeFile.bind(fs);
  fs.writeFile = async (...args) => {
    await original(...args);
    throw failure;
  };
  journalArtifactFilesystem(fs, project_id, journal);
  await expect(fs.writeFile("a.chat", '{"partial":true}\n')).rejects.toBe(
    failure,
  );
  expect(journal.scans()).toHaveLength(1);
  const read = jest.fn(async () => {
    expect(await readArtifactSource(fs, "a.chat")).toEqual([{ partial: true }]);
    return [];
  });
  const send = jest.fn();
  await new ArtifactCatalogProjector({
    journal,
    read,
    send,
    onError: jest.fn(),
  }).runOnce();
  expect(read).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(journal.scans()).toEqual([]);
});

test.each(["rm", "rmdir"] as const)(
  "%s dirties every indexed descendant across pages, not sibling prefixes",
  async (method) => {
    await fs.mkdir("tree");
    for (let i = 0; i < 105; i++) clean(`tree/${i}.chat`);
    clean("tree-other/untouched.chat");
    journalArtifactFilesystem(fs, project_id, journal);
    if (method === "rm") await fs.rm("tree", { recursive: true });
    else await fs.rmdir("tree");
    const scans = journal.scans(100);
    expect(scans).toHaveLength(100);
    for (const scan of scans) {
      expect(scan.chat_path.startsWith("/home/user/tree/")).toBe(true);
      journal.prepare(scan, []);
    }
    expect(journal.scans(100)).toHaveLength(5);
    expect(await fs.exists("tree")).toBe(false);
  },
);

test("directory rename invalidates source, mapped destination, and preexisting destination descendants", async () => {
  await fs.mkdir("old");
  await fs.writeFile("old/a.chat", "{}\n");
  for (const path of [
    "old/a.chat",
    "old/nested/deleted.chat",
    "new/stale.chat",
    "newish/untouched.chat",
  ])
    clean(path);
  journalArtifactFilesystem(fs, project_id, journal);
  await fs.rename("old", "new");
  expect(
    journal
      .scans(100)
      .map((s) => s.chat_path)
      .sort(),
  ).toEqual([
    "/home/user/new/stale.chat",
    "/home/user/old/a.chat",
    "/home/user/old/nested/deleted.chat",
  ]);
  expect(
    journal
      .pendingRegistrations()
      .map((s) => s.chat_path)
      .sort(),
  ).toEqual(["/home/user/new/a.chat", "/home/user/new/nested/deleted.chat"]);
  expect(await readArtifactSource(fs, "new/a.chat")).toEqual([{}]);
  expect(await readArtifactSource(fs, "old/a.chat")).toEqual([]);
});

test("failed symlink writes and successful relative/absolute writes use one canonical .chat identity", async () => {
  await fs.mkdir("real");
  await symlink("real", join(dir, "home", "alias"));
  journalArtifactFilesystem(fs, project_id, journal);
  await expect(fs.writeFile("alias/a.chat", "{}\n")).rejects.toMatchObject({
    code: "EACCES",
  });
  await fs.writeFile("./real/a.chat", "{}\n");
  await fs.appendFile("/home/user/real/a.chat", "{}\n");
  await fs.writeFile("real/ignored.chat.bak", "{}");
  expect(journal.sources(project_id)).toEqual([source("real/a.chat")]);
});

test.each(["copyFile", "cp"] as const)(
  "%s journals the destination rather than the unchanged source",
  async (method) => {
    await fs.writeFile("source.chat", "{}\n");
    clean("source.chat");
    clean("destination.chat");
    journalArtifactFilesystem(fs, project_id, journal);
    await fs[method]("source.chat", "destination.chat");
    expect(journal.scans().map((s) => s.chat_path)).toEqual([
      source("destination.chat").chat_path,
    ]);
    expect(await readArtifactSource(fs, "destination.chat")).toEqual([{}]);
  },
);

test("unlink reconciles a missing source as an empty snapshot", async () => {
  await fs.writeFile("a.chat", "{}\n");
  clean("a.chat");
  journalArtifactFilesystem(fs, project_id, journal);
  await fs.unlink("a.chat");
  expect(journal.scans()).toHaveLength(1);
  expect(await readArtifactSource(fs, "a.chat")).toEqual([]);
});

test("reads JSON lines and accepts exactly the byte limit, including multibyte text", async () => {
  const content = '\n {"value":"\u00e9"}\n\t\n{"second":2}\n';
  await fs.writeFile("a.chat", content);
  expect(
    await readArtifactSource(fs, "a.chat", Buffer.byteLength(content)),
  ).toEqual([{ value: "\u00e9" }, { second: 2 }]);
  await expect(
    readArtifactSource(fs, "a.chat", Buffer.byteLength(content) - 1),
  ).rejects.toThrow("exceeds catalog read limit");
});

test.each([
  ["malformed JSON", "{}\n{broken}\n", 1024],
  ["over byte limit", "{}\n{}\n", 3],
] as const)(
  "%s remains an error, never an empty replacement",
  async (_name, content, maxBytes) => {
    await writeFile(join(dir, "home", "a.chat"), content);
    journal.register(source("a.chat"), "epoch");
    const send = jest.fn();
    const onError = jest.fn();
    await new ArtifactCatalogProjector({
      journal,
      read: async () => {
        await readArtifactSource(fs, "a.chat", maxBytes);
        return [];
      },
      send,
      onError,
    }).runOnce();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(send).not.toHaveBeenCalled();
    expect(journal.scans(32, Date.now() + 60_000)).toHaveLength(1);
  },
);

test("missing sources return [] but non-ENOENT errors retain their identity", async () => {
  expect(await readArtifactSource(fs, "missing.chat")).toEqual([]);
  const failure = Object.assign(Error("denied"), { code: "EACCES" });
  jest.spyOn(fs, "createReadStream").mockRejectedValueOnce(failure);
  await expect(readArtifactSource(fs, "a.chat")).rejects.toBe(failure);
});
