/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cp from "./cp";

describe("sandbox cp", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("replaces a destination symlink instead of following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cocalc-cp-symlink-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    const outside = join(root, "outside.txt");
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, "file.txt"), "source");
    await writeFile(outside, "outside");
    await symlink(outside, join(destination, "file.txt"));

    await cp(source, destination, { recursive: true });

    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
    await expect(readFile(join(destination, "file.txt"), "utf8")).resolves.toBe(
      "source",
    );
    expect((await lstat(join(destination, "file.txt"))).isSymbolicLink()).toBe(
      false,
    );
  });
});
