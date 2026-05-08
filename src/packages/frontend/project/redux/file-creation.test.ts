/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  constructAbsolutePath,
  createFile,
  ensureDirectoryExists,
} from "./file-creation";

describe("project redux file creation", () => {
  it("constructs absolute paths and appends missing extensions", () => {
    expect(
      constructAbsolutePath({
        name: "notes",
        currentPath: "/home/user",
        ext: "md",
        toAbsoluteCurrentPath: (path) => path,
      }),
    ).toBe("/home/user/notes.md");

    expect(() =>
      constructAbsolutePath({
        name: "",
        currentPath: "/home/user",
        toAbsoluteCurrentPath: (path) => path,
      }),
    ).toThrow("Cannot use empty filename");
  });

  it("rejects banned file extensions before writing", async () => {
    const writeFile = jest.fn();
    const setFileCreationError = jest.fn();

    await createFile({
      name: "report",
      ext: "pdf",
      currentPath: "/home/user",
      projectId: "project-id",
      fs: () => ({ writeFile }) as any,
      toAbsoluteCurrentPath: (path) => path,
      setFileCreationError,
      createFolder: jest.fn(),
      newFileFromWeb: jest.fn(),
      ensureContainingDirectoryExists: jest.fn(),
      log: jest.fn(),
      getPreferredKernel: jest.fn(),
      addCreatedTag: jest.fn(),
      openFile: jest.fn(),
    });

    expect(setFileCreationError).toHaveBeenLastCalledWith(
      "Cannot create a file with the pdf extension",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes a valid file and opens it when switching over", async () => {
    const writeFile = jest.fn().mockResolvedValue(undefined);
    const ensureContainingDirectoryExists = jest
      .fn()
      .mockResolvedValue(undefined);
    const openFile = jest.fn();
    const addCreatedTag = jest.fn();

    await createFile({
      name: "notes",
      ext: "md",
      currentPath: "/home/user",
      projectId: "project-id",
      fs: () => ({ writeFile }) as any,
      toAbsoluteCurrentPath: (path) => path,
      setFileCreationError: jest.fn(),
      createFolder: jest.fn(),
      newFileFromWeb: jest.fn(),
      ensureContainingDirectoryExists,
      log: jest.fn(),
      getPreferredKernel: jest.fn(),
      addCreatedTag,
      openFile,
    });

    expect(ensureContainingDirectoryExists).toHaveBeenCalledWith(
      "/home/user/notes.md",
    );
    expect(writeFile).toHaveBeenCalledWith("/home/user/notes.md", "");
    expect(addCreatedTag).toHaveBeenCalledWith("create-md");
    expect(openFile).toHaveBeenCalledWith({
      path: "/home/user/notes.md",
      explicit: true,
      foreground: true,
    });
  });

  it("does not mkdir when the directory is already present in cache", async () => {
    const mkdir = jest.fn();

    await ensureDirectoryExists({
      path: "/home/user/existing",
      fs: () => ({ mkdir }) as any,
      getFilesCache: () => ({ existing: { isDir: true } }),
    });

    expect(mkdir).not.toHaveBeenCalled();
  });
});
