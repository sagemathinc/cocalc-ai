/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  waitForCompletion: jest.fn(),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitProjectRoutedClient: jest.fn(),
}));

jest.mock("@cocalc/server/conat/api/project-backups", () => ({
  __esModule: true,
  createBackup: jest.fn(),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: jest.fn(),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: jest.fn(),
}));

jest.mock("./copy-db", () => ({
  __esModule: true,
  insertCopyRowIfMissing: jest.fn(),
  upsertCopyRow: jest.fn(),
}));

function mockFs({
  canonical,
  dirs = new Set<string>(),
  children = {},
}: {
  canonical: Record<string, string>;
  dirs?: Set<string>;
  children?: Record<string, string[]>;
}) {
  return {
    canonicalSyncIdentityPath: jest.fn(async (path: string) => canonical[path]),
    stat: jest.fn(async (path: string) => ({
      isDirectory: () => dirs.has(path),
    })),
    readdir: jest.fn(async (path: string) =>
      (children[path] ?? []).map((name) => ({ name })),
    ),
  } as any;
}

describe("copy viewer read policy enforcement", () => {
  it("skips recursive validation when a non-dereferencing copy is allowed for the whole subtree", async () => {
    const { assertCopySourceAllowedByReadPolicy } = await import("./copy");
    const fs = mockFs({
      canonical: {
        public: "/home/user/public",
        "public/a.txt": "/home/user/public/a.txt",
        "public/nested": "/home/user/public/nested",
        "public/nested/b.txt": "/home/user/public/nested/b.txt",
      },
      dirs: new Set(["public", "public/nested"]),
      children: {
        public: ["a.txt", "nested"],
        "public/nested": ["b.txt"],
      },
    });

    await expect(
      assertCopySourceAllowedByReadPolicy({
        fs,
        read_policy: { rules: [{ action: "include", path: "public/**" }] },
        src_paths: ["public"],
        options: { recursive: true },
      }),
    ).resolves.toBeUndefined();
    expect(fs.stat).toHaveBeenCalledWith("public");
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it("walks recursive copies when the policy has a nested exclusion", async () => {
    const { assertCopySourceAllowedByReadPolicy } = await import("./copy");
    const fs = mockFs({
      canonical: {
        public: "/home/user/public",
        "public/a.txt": "/home/user/public/a.txt",
        "public/private": "/home/user/public/private",
        "public/private/secret.txt": "/home/user/public/private/secret.txt",
      },
      dirs: new Set(["public", "public/private"]),
      children: {
        public: ["a.txt", "private"],
        "public/private": ["secret.txt"],
      },
    });

    await expect(
      assertCopySourceAllowedByReadPolicy({
        fs,
        read_policy: {
          rules: [
            { action: "include", path: "public/**" },
            { action: "exclude", path: "public/private/**" },
          ],
        },
        src_paths: ["public"],
        options: { recursive: true },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(fs.readdir).toHaveBeenCalledWith("public", { withFileTypes: true });
  });

  it("rejects denied child targets when recursive copy dereferences symlinks", async () => {
    const { assertCopySourceAllowedByReadPolicy } = await import("./copy");
    const fs = mockFs({
      canonical: {
        public: "/home/user/public",
        "public/a.txt": "/home/user/public/a.txt",
        "public/secret-link": "/home/user/private/secret.txt",
      },
      dirs: new Set(["public"]),
      children: {
        public: ["a.txt", "secret-link"],
      },
    });

    await expect(
      assertCopySourceAllowedByReadPolicy({
        fs,
        read_policy: { rules: [{ action: "include", path: "public/**" }] },
        src_paths: ["public"],
        options: { recursive: true, dereference: true },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects non-home canonical paths", async () => {
    const { assertCopySourceAllowedByReadPolicy } = await import("./copy");
    const fs = mockFs({
      canonical: {
        "tmp-token": "/tmp/runtime-token",
      },
    });

    await expect(
      assertCopySourceAllowedByReadPolicy({
        fs,
        read_policy: { rules: [{ action: "include", path: "." }] },
        src_paths: ["tmp-token"],
        options: { recursive: true },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
