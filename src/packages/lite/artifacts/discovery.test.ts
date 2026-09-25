/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteArtifactDiscovery } from "./discovery";

test("bounded incremental backfill skips symlinks, dependencies and private data", async () => {
  const root = await mkdtemp(join(tmpdir(), "lite-artifact-discovery-"));
  const privateDirectory = join(root, "private");
  const discovery = new LiteArtifactDiscovery(root, privateDirectory);
  try {
    for (const name of [
      "private",
      "node_modules",
      ".git",
      "vendor",
      ".venv",
      "venv",
      "dist",
      "build",
      "nested",
    ]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "artifact.chat"), "");
    }
    await symlink(join(root, "nested"), join(root, "link"));
    for (let i = 0; i < 105; i++) await writeFile(join(root, `${i}.chat`), "");
    const first = await discovery.page();
    expect(first.length).toBeLessThanOrEqual(100);
    const found = new Set(first);
    for (let i = 0; i < 5; i++)
      for (const path of await discovery.page()) found.add(path);
    expect(found.size).toBe(106);
    expect(found.has(join(root, "nested", "artifact.chat"))).toBe(true);
    expect(
      [...found].some((path) =>
        /\/(private|node_modules|\.git|vendor|\.venv|venv|dist|build|link)\//.test(
          path,
        ),
      ),
    ).toBe(false);
    await discovery.close();
    expect(await discovery.page()).toEqual([]);
  } finally {
    await discovery.close();
    await rm(root, { recursive: true, force: true });
  }
});
