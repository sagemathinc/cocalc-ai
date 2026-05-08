/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { copyPaths, deleteMatchingFiles } from "./file-operations";

describe("project redux file operations", () => {
  it("copies normalized paths and logs directory destinations", async () => {
    const cp = jest.fn().mockResolvedValue(undefined);
    const setActivity = jest.fn();
    const log = jest.fn();

    await copyPaths({
      src: ["/src/dir", "/src/file.txt"],
      dest: "/dest",
      fs: () => ({ cp }) as any,
      setActivity,
      log,
      appendSlashToDirectoryPaths: jest
        .fn()
        .mockResolvedValue(["/src/dir/", "/src/file.txt"]),
    });

    expect(log).toHaveBeenCalledWith({
      event: "file_action",
      action: "copied",
      files: ["/src/dir/", "/src/file.txt"],
      count: 2,
      dest: "/dest/",
    });
    expect(cp).toHaveBeenCalledWith(["/src/dir", "/src/file.txt"], "/dest", {
      recursive: true,
      reflink: true,
    });
    expect(setActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ stop: "" }),
    );
  });

  it("uses slash-normalized source paths when copying only directory contents", async () => {
    const cp = jest.fn().mockResolvedValue(undefined);

    await copyPaths({
      src: ["/src/dir"],
      dest: "/dest",
      only_contents: true,
      fs: () => ({ cp }) as any,
      setActivity: jest.fn(),
      log: jest.fn(),
      appendSlashToDirectoryPaths: jest.fn().mockResolvedValue(["/src/dir/"]),
    });

    expect(cp).toHaveBeenCalledWith(["/src/dir/"], "/dest", {
      recursive: true,
      reflink: true,
    });
  });

  it("deletes matching fd results and returns the selected paths", async () => {
    const fd = jest.fn().mockResolvedValue({
      stdout: Buffer.from("keep.txt\nskip.log\n"),
    });
    const deleteFiles = jest.fn().mockResolvedValue(undefined);

    const deleted = await deleteMatchingFiles({
      path: "/tmp",
      filter: (path) => path.endsWith(".txt"),
      fs: () => ({ fd }) as any,
      deleteFiles,
    });

    expect(fd).toHaveBeenCalledWith("/tmp", {
      options: ["-H", "-I", "-d", "1"],
    });
    expect(deleteFiles).toHaveBeenCalledWith({ paths: ["/tmp/keep.txt"] });
    expect(deleted).toEqual(["/tmp/keep.txt"]);
  });
});
