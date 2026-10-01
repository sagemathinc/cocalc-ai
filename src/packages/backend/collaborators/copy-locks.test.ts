import { withCollaborationCopyLock } from "./copy-locks";
import { CollaborationJournal } from "./journal";
import { journalCollaborationFilesystem } from "./filesystem";
const source = {
  project_id: "11111111-1111-4111-8111-111111111111",
  chat_path: "/home/user/copy.chat",
};
test("namespace save excludes copy, rename and delete while allowing the live SyncDB save", async () => {
  const journal = new CollaborationJournal(":memory:");
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
  const unlink = fs.unlink,
    copy = fs.copyFile,
    rename = fs.rename,
    write = fs.writeFile;
  try {
    journalCollaborationFilesystem(fs, source.project_id, journal);
    await withCollaborationCopyLock([source], async () => {
      await expect(
        fs.copyFile("/home/user/other.chat", source.chat_path),
      ).rejects.toThrow(/busy/);
      await expect(
        fs.rename(source.chat_path, "/home/user/moved.chat"),
      ).rejects.toThrow(/busy/);
      await expect(fs.unlink(source.chat_path)).rejects.toThrow(/busy/);
      await fs.writeFile(source.chat_path, "SyncDB saved marker");
      expect(journal.relocations()).toEqual([]);
      expect(journal.copies()).toEqual([]);
    });
    expect(unlink).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    await fs.unlink(source.chat_path);
    expect(unlink).toHaveBeenCalledTimes(1);
  } finally {
    journal.close();
  }
});
test("locks release after failed initialization and do not block independent sources", async () => {
  await expect(
    withCollaborationCopyLock([source], async () => {
      await withCollaborationCopyLock(
        [{ ...source, chat_path: "/home/user/other.chat" }],
        async () => {},
      );
      await expect(
        withCollaborationCopyLock([source], async () => {}),
      ).rejects.toThrow(/busy/);
      throw Error("save failed");
    }),
  ).rejects.toThrow(/save failed/);
  await withCollaborationCopyLock([source], async () => {});
});
