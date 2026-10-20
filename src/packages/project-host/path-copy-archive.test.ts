/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archivePathIsAllowed,
  decodePathCopyArchiveListing,
  installPathFromStaging,
  mergePathFromStaging,
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

// An ordinary copy into a project's home: each file appears atomically, so a
// student opening a handed-out notebook never sees it missing, empty or half
// written (support ticket 21023).
describe("atomic merge copy into a project home", () => {
  let root: string;
  let home: string;
  let source: string;
  const nodeCopy = async (src: string, dest: string) => {
    await cp(src, dest, { recursive: true });
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cocalc-atomic-copy-"));
    home = path.join(root, "home");
    source = path.join(root, "source", "lab");
    await mkdir(path.join(source, "data"), { recursive: true });
    await writeFile(path.join(source, "lab.ipynb"), "LAB");
    await writeFile(path.join(source, "data", "x.csv"), "1,2");
    await mkdir(home);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const leftovers = async (dir: string) =>
    (await readdir(dir)).filter((name) => name.includes("cocalc-incoming"));

  it("never writes into the destination while copying", async () => {
    const destination = path.join(home, "assignments", "lab");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "lab.ipynb"), "OLD");
    const before = await stat(path.join(destination, "lab.ipynb"));

    await mergePathFromStaging({
      home,
      source,
      destination,
      copy: async (src, dest) => {
        // While the copy runs, the student still sees the old notebook.
        expect(
          await readFile(path.join(destination, "lab.ipynb"), "utf8"),
        ).toBe("OLD");
        await nodeCopy(src, dest);
      },
    });

    const after = await stat(path.join(destination, "lab.ipynb"));
    expect(await readFile(path.join(destination, "lab.ipynb"), "utf8")).toBe(
      "LAB",
    );
    // Replaced by a rename (a new inode), not rewritten in place.
    expect(after.ino).not.toBe(before.ino);
    expect(await leftovers(path.join(home, "assignments"))).toEqual([]);
  });

  it("merges into an existing directory and keeps other files", async () => {
    const destination = path.join(home, "lab");
    await mkdir(path.join(destination, "data"), { recursive: true });
    await writeFile(path.join(destination, "notes.md"), "mine");
    await writeFile(path.join(destination, "data", "y.csv"), "3,4");

    await mergePathFromStaging({ home, source, destination, copy: nodeCopy });

    expect(await readFile(path.join(destination, "notes.md"), "utf8")).toBe(
      "mine",
    );
    expect(
      await readFile(path.join(destination, "data", "y.csv"), "utf8"),
    ).toBe("3,4");
    expect(
      await readFile(path.join(destination, "data", "x.csv"), "utf8"),
    ).toBe("1,2");
    expect(await readFile(path.join(destination, "lab.ipynb"), "utf8")).toBe(
      "LAB",
    );
  });

  it("installs a missing destination", async () => {
    const destination = path.join(home, "new", "lab");
    await mergePathFromStaging({ home, source, destination, copy: nodeCopy });
    expect(await readFile(path.join(destination, "lab.ipynb"), "utf8")).toBe(
      "LAB",
    );
    expect(await leftovers(path.join(home, "new"))).toEqual([]);
  });

  it("keeps existing files when force is false", async () => {
    const destination = path.join(home, "lab");
    await mkdir(destination);
    await writeFile(path.join(destination, "lab.ipynb"), "STUDENT WORK");

    await mergePathFromStaging({
      home,
      source,
      destination,
      options: { force: false },
      copy: nodeCopy,
    });

    expect(await readFile(path.join(destination, "lab.ipynb"), "utf8")).toBe(
      "STUDENT WORK",
    );
    expect(
      await readFile(path.join(destination, "data", "x.csv"), "utf8"),
    ).toBe("1,2");
  });

  it("refuses an existing destination with errorOnExist", async () => {
    const destination = path.join(home, "lab");
    await mkdir(destination);
    const copy = jest.fn(nodeCopy);
    await expect(
      mergePathFromStaging({
        home,
        source,
        destination,
        options: { force: false, errorOnExist: true },
        copy,
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
    expect(copy).not.toHaveBeenCalled();
  });

  it("never writes through a symlink planted in the destination", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const destination = path.join(home, "lab");
    await mkdir(destination);
    await symlink(outside, path.join(destination, "data"));

    await expect(
      mergePathFromStaging({ home, source, destination, copy: nodeCopy }),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    expect(await leftovers(home)).toEqual([]);
  });

  it("does not replace a directory with a file", async () => {
    const destination = path.join(home, "lab");
    await mkdir(path.join(destination, "lab.ipynb"), { recursive: true });
    await expect(
      mergePathFromStaging({ home, source, destination, copy: nodeCopy }),
    ).rejects.toThrow(/cannot overwrite directory/);
  });

  it("is used by installPathFromStaging for an ordinary copy into the home", async () => {
    const destination = path.join(home, "lab");
    await mkdir(destination);
    await writeFile(path.join(destination, "lab.ipynb"), "OLD");
    await installPathFromStaging({
      source,
      destination,
      destinationExists: true,
      home,
      copy: async (src, dest) => {
        expect(dest).not.toBe(destination); // staged, not in place
        await nodeCopy(src, dest);
      },
    });
    expect(await readFile(path.join(destination, "lab.ipynb"), "utf8")).toBe(
      "LAB",
    );
  });
});
