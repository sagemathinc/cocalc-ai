/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSandboxDirectoryStream } from "./directory-stream";

const linux = process.platform === "linux" ? test : test.skip;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "census-directory-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

linux(
  "streams entries without whole-directory arrays and closes idempotently",
  async () => {
    await mkdir(join(root, "nested"));
    for (let i = 0; i < 105; i++)
      await writeFile(join(root, "nested", `${i}.chat`), "untouched");
    const stream = await openSandboxDirectoryStream(root, join(root, "nested"));
    try {
      const names = new Set<string>();
      for (let i = 0; i < 105; i++) names.add((await stream.read())!.name);
      expect(names.size).toBe(105);
      expect(await stream.read()).toBeNull();
      await stream.assertCurrent();
    } finally {
      await stream.close();
      await stream.close();
    }
    await expect(stream.read()).rejects.toMatchObject({ code: "EBADF" });
  },
);

linux(
  "rejects links in every path component, including links inside the allowed root",
  async () => {
    await mkdir(join(root, "real", "child"), { recursive: true });
    await symlink(join(root, "real"), join(root, "link"));
    await expect(
      openSandboxDirectoryStream(root, join(root, "link", "child")),
    ).rejects.toThrow();
    await expect(
      openSandboxDirectoryStream(join(root, "link"), join(root, "link")),
    ).rejects.toThrow();
    await expect(
      openSandboxDirectoryStream(root, "/tmp"),
    ).rejects.toMatchObject({ code: "EXDEV" });
  },
);

linux(
  "an opened directory rename or later mutation invalidates its cursor",
  async () => {
    await mkdir(join(root, "nested"));
    const stream = await openSandboxDirectoryStream(root, join(root, "nested"));
    try {
      await rename(join(root, "nested"), join(root, "moved"));
      await mkdir(join(root, "nested"));
      await expect(stream.read()).rejects.toMatchObject({ code: "ESTALE" });
    } finally {
      await stream.close();
    }
    const changed = await openSandboxDirectoryStream(
      root,
      join(root, "nested"),
    );
    try {
      await writeFile(join(root, "nested", "new.chat"), "not silently missed");
      await expect(changed.assertCurrent()).rejects.toMatchObject({
        code: "ESTALE",
      });
    } finally {
      await changed.close();
    }
  },
);

linux(
  "replacing a home volume cannot keep an old open cursor alive",
  async () => {
    const home = join(root, "home");
    await mkdir(home);
    const stream = await openSandboxDirectoryStream(home, home);
    try {
      await rename(home, join(root, "retired"));
      await mkdir(home);
      await expect(stream.read()).rejects.toMatchObject({ code: "ESTALE" });
    } finally {
      await stream.close();
    }
  },
);

linux(
  "a proc mount under the real root is rejected without enumerating it",
  async () => {
    await expect(
      openSandboxDirectoryStream("/", "/proc"),
    ).rejects.toMatchObject({ code: "EXDEV" });
  },
);

linux(
  "missing directories remain errors, and global stream admission is bounded",
  async () => {
    await expect(
      openSandboxDirectoryStream(root, join(root, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const streams: Awaited<ReturnType<typeof openSandboxDirectoryStream>>[] =
      [];
    try {
      for (let i = 0; i < 32; i++)
        streams.push(await openSandboxDirectoryStream(root, root));
      await expect(
        openSandboxDirectoryStream(root, root),
      ).rejects.toMatchObject({ code: "EBUSY" });
    } finally {
      for (const stream of streams) await stream.close();
    }
    const again = await openSandboxDirectoryStream(root, root);
    await again.close();
  },
);
