/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY } from "@cocalc/util/project-access";
import type { Filesystem } from "@cocalc/conat/files/fs";
import { createViewerReadOnlyFilesystem } from "./viewer-read-only-filesystem";

function mockFilesystem(
  overrides: Partial<Filesystem> = {},
): jest.Mocked<Filesystem> {
  return {
    constants: jest.fn(async () => ({})),
    describeFile: jest.fn(async () => ({ mime: "text/plain" })),
    exists: jest.fn(async () => true),
    getListing: jest.fn(async () => ({ files: {} })),
    lstat: jest.fn(async () => ({}) as any),
    readFile: jest.fn(async () => "content"),
    readdir: jest.fn(async () => []),
    readlink: jest.fn(async () => "target"),
    realpath: jest.fn(async (path: string) => path),
    canonicalSyncIdentityPath: jest.fn(async (path: string) => path),
    stat: jest.fn(async () => ({}) as any),
    ...overrides,
  } as jest.Mocked<Filesystem>;
}

describe("viewer read-only filesystem boundary", () => {
  it("allows included project-home files using canonical identity paths", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async () => "/home/user/docs/a.txt"),
      readFile: jest.fn(async () => "allowed"),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "docs/**" }] },
    });

    await expect(
      viewerFs.readFile("/home/user/docs/a.txt", "utf8"),
    ).resolves.toBe("allowed");
    expect(fs.readFile).toHaveBeenCalledWith(
      "/home/user/docs/a.txt",
      "utf8",
      undefined,
    );
  });

  it("rejects non-home absolute canonical paths even with full-project access", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async () => "/tmp/runtime-token"),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
    });

    await expect(viewerFs.readFile("/tmp/runtime-token")).rejects.toMatchObject(
      {
        code: "EACCES",
      },
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("rejects symlink-style escapes based on the resolved canonical path", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async (path: string) =>
        path === "public/link" ? "/home/user/private/secret.txt" : path,
      ),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "public/**" }] },
    });

    await expect(viewerFs.readFile("public/link")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("filters directory entries whose resolved child paths are denied", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async (path: string) =>
        path === "public/private-link" ? "/home/user/private/secret.txt" : path,
      ),
      readdir: jest.fn(async () => ["ok.txt", "private-link"]),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "public/**" }] },
    });

    await expect(viewerFs.readdir("public")).resolves.toEqual(["ok.txt"]);
  });

  it("filters getListing results through the viewer read policy", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async (path: string) =>
        path === "public/private-link" ? "/home/user/private/secret.txt" : path,
      ),
      getListing: jest.fn(async () => ({
        files: {
          "ok.txt": { type: "f", size: 1, mtime: 1 },
          "private-link": { type: "l", size: 1, mtime: 1 },
        },
      })),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "public/**" }] },
    });

    await expect(viewerFs.getListing("public")).resolves.toMatchObject({
      files: {
        "ok.txt": { type: "f" },
      },
    });
    await expect(viewerFs.getListing("public")).resolves.not.toHaveProperty([
      "files",
      "private-link",
    ]);
  });

  it("shows only navigable ancestors when listing above allowed viewer paths", async () => {
    const fs = mockFilesystem({
      canonicalSyncIdentityPath: jest.fn(async (path: string) =>
        path === "/home/user" ? "/home/user" : path,
      ),
      getListing: jest.fn(async () => ({
        files: {
          foo: { type: "d", isDir: true, size: 0, mtime: 1 },
          private: { type: "d", isDir: true, size: 0, mtime: 1 },
          "README.md": { type: "f", size: 1, mtime: 1 },
        },
      })),
    });
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "foo/bar/**" }] },
    });

    await expect(viewerFs.getListing("/home/user")).resolves.toMatchObject({
      files: {
        foo: { type: "d" },
      },
    });
    await expect(viewerFs.getListing("/home/user")).resolves.not.toHaveProperty(
      ["files", "private"],
    );
    await expect(viewerFs.getListing("/home/user")).resolves.not.toHaveProperty(
      ["files", "README.md"],
    );
  });

  it("rejects listings outside allowed paths and their ancestors", async () => {
    const fs = mockFilesystem();
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: { rules: [{ action: "include", path: "foo/bar/**" }] },
    });

    await expect(viewerFs.getListing("private")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(fs.getListing).not.toHaveBeenCalled();
  });

  it("enforces full-project default sensitive-path excludes at the project-host boundary", async () => {
    const fs = mockFilesystem();
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
    });

    await expect(viewerFs.readFile("README.md")).resolves.toBe("content");
    await expect(viewerFs.readFile(".snapshots/a")).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(viewerFs.readFile(".ssh/id_ed25519")).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(
      viewerFs.readFile(".local/share/cocalc/state.json"),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects recursive directory listings", async () => {
    const fs = mockFilesystem();
    const viewerFs = createViewerReadOnlyFilesystem({
      fs,
      readPolicy: DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
    });

    await expect(
      viewerFs.readdir(".", { recursive: true } as any),
    ).rejects.toThrow("recursive viewer directory listing is not supported");
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it("does not expose mutating filesystem methods", () => {
    const viewerFs = createViewerReadOnlyFilesystem({
      fs: mockFilesystem(),
      readPolicy: DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
    }) as any;

    expect(viewerFs.writeFile).toBeUndefined();
    expect(viewerFs.mkdir).toBeUndefined();
    expect(viewerFs.rm).toBeUndefined();
    expect(viewerFs.rename).toBeUndefined();
  });
});
