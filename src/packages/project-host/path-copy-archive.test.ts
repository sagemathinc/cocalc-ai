/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archivePathIsAllowed,
  decodePathCopyArchiveListing,
  installPathFromStaging,
  replacePathFromStaging,
} from "./path-copy-archive";

describe("path copy archive listings", () => {
  it("decodes GNU tar C-quoted UTF-8 paths before validation", () => {
    const entries = decodePathCopyArchiveListing(
      Buffer.from(
        '"Introduction \\303\\240 l\'informatique.ipynb"\n' +
          '"Introduction \\303\\240 l\'informatique.ipynb/data.json"\n',
      ),
    );

    expect(entries).toEqual([
      "Introduction à l'informatique.ipynb",
      "Introduction à l'informatique.ipynb/data.json",
    ]);
    const allowedRoots = new Set(["Introduction à l'informatique.ipynb"]);
    expect(
      entries.every((entry) => archivePathIsAllowed({ entry, allowedRoots })),
    ).toBe(true);
  });

  it("continues to reject paths outside the selected roots", () => {
    const allowedRoots = new Set(["assignment"]);
    for (const entry of [
      "../outside",
      "/absolute",
      "assignment/../../outside",
      "assignment\\..\\outside",
      "other/file",
    ]) {
      expect(archivePathIsAllowed({ entry, allowedRoots })).toBe(false);
    }
  });

  it("rejects unexpected text after a quoted archive path", () => {
    expect(() =>
      decodePathCopyArchiveListing(Buffer.from('"assignment/file" trailing\n')),
    ).toThrow("unexpected output");
  });

  it("replaces an existing directory at the exact destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-replace-"));
    try {
      const source = path.join(root, "source-assignment");
      const destination = path.join(root, "collected-assignment");
      await mkdir(source);
      await mkdir(destination);
      await writeFile(path.join(source, "new.txt"), "new");
      await writeFile(path.join(destination, "old.txt"), "old");

      await replacePathFromStaging({
        source,
        destination,
        destinationExists: true,
        copy: async (src, dest) => {
          await cp(src, dest, { recursive: true });
        },
      });

      expect(await readFile(path.join(destination, "new.txt"), "utf8")).toBe(
        "new",
      );
      await expect(
        readFile(path.join(destination, "old.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          path.join(destination, "source-assignment", "new.txt"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges an ordinary directory copy at the resolved destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-merge-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "handouts", "lecture notes");
      await mkdir(source);
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(source, "new.txt"), "new");
      await writeFile(path.join(destination, "keep.txt"), "keep");

      await installPathFromStaging({
        source,
        destination,
        destinationExists: true,
        options: { force: false },
        copy: async (src, dest) => {
          await cp(src, dest, { force: false, recursive: true });
        },
      });

      expect(await readFile(path.join(destination, "new.txt"), "utf8")).toBe(
        "new",
      );
      expect(await readFile(path.join(destination, "keep.txt"), "utf8")).toBe(
        "keep",
      );
      await expect(
        readFile(path.join(destination, "source", "new.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an exact no-clobber copy when the destination exists", async () => {
    const copy = jest.fn();
    await expect(
      installPathFromStaging({
        source: "/staging/source",
        destination: "/project/destination",
        destinationExists: true,
        exact: true,
        options: { force: false },
        copy,
      }),
    ).resolves.toBe(false);
    expect(copy).not.toHaveBeenCalled();
  });

  it("leaves the destination untouched when staging the copy fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocalc-copy-replace-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      await mkdir(source);
      await mkdir(destination);
      await writeFile(path.join(destination, "keep.txt"), "keep");

      await expect(
        replacePathFromStaging({
          source,
          destination,
          destinationExists: true,
          copy: async () => {
            throw new Error("copy failed");
          },
        }),
      ).rejects.toThrow("copy failed");
      expect(await readFile(path.join(destination, "keep.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
