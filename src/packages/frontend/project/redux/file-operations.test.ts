/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { copyPaths, deleteFiles, deleteMatchingFiles } from "./file-operations";

const mockDeleteSnapshot = jest.fn();
const mockPruneSnapshotPath = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        projects: {
          deleteSnapshot: (...args: any[]) => mockDeleteSnapshot(...args),
          pruneSnapshotPath: (...args: any[]) => mockPruneSnapshotPath(...args),
        },
      },
    },
  },
}));

describe("project redux file operations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it("prunes ordinary paths from snapshots before deleting live files", async () => {
    const rm = jest.fn().mockResolvedValue(undefined);
    const setActivity = jest.fn();
    const log = jest.fn();

    await deleteFiles({
      paths: ["/home/user/large"],
      deleteFromSnapshots: true,
      projectId: "project-1",
      fs: () => ({ rm }) as any,
      setActivity,
      log,
    });

    expect(mockPruneSnapshotPath).toHaveBeenCalledWith({
      browser_id: "browser-1",
      project_id: "project-1",
      path: "/home/user/large",
      timeout: 10 * 60 * 1000,
    });
    expect(rm).toHaveBeenCalledWith(["/home/user/large"], {
      force: true,
      recursive: true,
      sudo: false,
    });
    expect(mockPruneSnapshotPath.mock.invocationCallOrder[0]).toBeLessThan(
      rm.mock.invocationCallOrder[0],
    );
  });

  it("prunes snapshot-entry relative paths without deleting read-only snapshot files", async () => {
    const rm = jest.fn().mockResolvedValue(undefined);

    await deleteFiles({
      paths: [".snapshots/manual-1/large/data"],
      deleteFromSnapshots: true,
      projectId: "project-1",
      fs: () => ({ rm }) as any,
      setActivity: jest.fn(),
      log: jest.fn(),
    });

    expect(mockPruneSnapshotPath).toHaveBeenCalledWith({
      browser_id: "browser-1",
      project_id: "project-1",
      path: "large/data",
      timeout: 10 * 60 * 1000,
    });
    expect(rm).not.toHaveBeenCalled();
  });
});
