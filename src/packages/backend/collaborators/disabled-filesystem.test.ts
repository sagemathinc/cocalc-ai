import { CollaborationJournal } from "./journal";
import { journalCollaborationFilesystem } from "./filesystem";
test("disabled and failed flag lookup pass every public mutation through before any journal, path or read work", async () => {
  let enabled = false;
  const setting = jest.fn(async () => enabled);
  const journal = new CollaborationJournal(
    ":memory:",
    undefined,
    false,
    setting,
  );
  const fs: any = {
    canonicalSyncIdentityPath: jest.fn(async (path) => path),
    lstat: jest.fn(),
    readdir: jest.fn(),
    createReadStream: jest.fn(),
  };
  const originals: Record<string, jest.Mock> = {};
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
    fs[name] = originals[name] = jest.fn(async () => name);
  const touch = jest.spyOn(journal, "beginWrite"),
    descendants = jest.spyOn(journal, "descendants"),
    copy = jest.spyOn(journal, "beginCopy");
  try {
    journalCollaborationFilesystem(
      fs,
      "11111111-1111-4111-8111-111111111111",
      journal,
    );
    for (const name of Object.keys(originals))
      expect(await fs[name]("/unbounded/tree", "/destination")).toBe(name);
    setting.mockRejectedValueOnce(Error("settings unavailable"));
    await fs.cp("/large/tree", "/copy");
    for (const spy of [
      touch,
      descendants,
      copy,
      fs.canonicalSyncIdentityPath,
      fs.lstat,
      fs.readdir,
      fs.createReadStream,
    ])
      expect(spy).not.toHaveBeenCalled();
    enabled = true;
    await fs.writeFile("/home/user/live.chat", "");
    expect(touch).toHaveBeenCalledTimes(1);
    enabled = false;
    await fs.writeFile("/home/user/live.chat", "");
    expect(touch).toHaveBeenCalledTimes(1);
  } finally {
    journal.close();
  }
});
test("disabled outer cp remains pass-through if its original implementation invokes wrapped copyFile", async () => {
  let enabled = false;
  const journal = new CollaborationJournal(
    ":memory:",
    undefined,
    false,
    async () => enabled,
  );
  const fs: any = { canonicalSyncIdentityPath: jest.fn(async (path) => path) };
  for (const name of [
    "writeFile",
    "appendFile",
    "unlink",
    "rm",
    "rmdir",
    "rename",
    "move",
    "copyFile",
  ])
    fs[name] = jest.fn(async () => {});
  const copy = fs.copyFile;
  fs.cp = async () => {
    enabled = true;
    await fs.copyFile("old.chat", "copy.chat");
  };
  try {
    journalCollaborationFilesystem(
      fs,
      "11111111-1111-4111-8111-111111111111",
      journal,
    );
    await fs.cp();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(fs.canonicalSyncIdentityPath).not.toHaveBeenCalled();
    expect(journal.sources()).toEqual([]);
  } finally {
    journal.close();
  }
});
test("reenable dirties retained sources without guessing redirects for moves performed while disabled", async () => {
  let enabled = true;
  const journal = new CollaborationJournal(
    ":memory:",
    undefined,
    false,
    async () => enabled,
  );
  const source = {
    project_id: "11111111-1111-4111-8111-111111111111",
    chat_path: "/home/user/old.chat",
  };
  const fs: any = { canonicalSyncIdentityPath: jest.fn(async (path) => path) };
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
  try {
    journal.touch(source);
    journal.registered(journal.registrations()[0], "epoch");
    journal.prepare(journal.scans()[0], { resources: [], activity_ids: {} });
    journal.acknowledge(journal.deliveries()[0]);
    expect(journal.scans()).toEqual([]);
    journalCollaborationFilesystem(fs, source.project_id, journal);
    enabled = false;
    await fs.rename(source.chat_path, "/home/user/new.chat");
    expect(fs.canonicalSyncIdentityPath).not.toHaveBeenCalled();
    expect(journal.relocations()).toEqual([]);
    expect(journal.scans()).toEqual([]);
    enabled = true;
    expect(await journal.isEnabled()).toBe(true);
    expect(journal.scans()).toEqual([expect.objectContaining(source)]);
    expect(journal.relocations()).toEqual([]);
  } finally {
    journal.close();
  }
});
